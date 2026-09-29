#!/usr/bin/env ruby
# frozen_string_literal: true

require "digest"
require "tempfile"
require_relative "app_store_connect"

# Apple retains the upload and its hash-named file identity, so retries can
# recover after acceptance but before receipt writes. ipaSha256 is our verified
# artifact digest; it is not an Apple-attested digest when its checksum is absent.
class TestFlightUpload < AppStoreConnectClient
  # Polls every 10 s for up to 30 minutes: Apple usually processes a build in a few minutes, and a coarser poll only
  # adds to every release (TAL-414).
  def upload(path, version, number, sha256, attempts: 180, delay: 10)
    unless version.match?(/\A\d+\.\d+\.\d+\z/) && number.match?(/\A[1-9]\d*\z/) &&
           sha256.match?(/\A[a-f0-9]{64}\z/) && Digest::SHA256.file(path).hexdigest == sha256
      raise Error, "Invalid or changed TestFlight artifact"
    end
    app = app_id_for_bundle_id("dev.kil.talaria")
    uploads = fetch_paginated_json("/v1/apps/#{app}/buildUploads", {
      "filter[cfBundleShortVersionString]" => version, "filter[cfBundleVersion]" => number,
      "filter[platform]" => "IOS", "limit" => "200"
    })
    raise Error, "Ambiguous App Store Connect uploads" if uploads.length > 1

    if uploads.empty?
      raise Error, "Build number already belongs to an unverified upload" unless builds(app, version, number).empty?

      upload = fetch_json("/v1/buildUploads", method: "POST", body: {data: {
        type: "buildUploads", attributes: {platform: "IOS", cfBundleShortVersionString: version, cfBundleVersion: number},
        relationships: {app: {data: {type: "apps", id: app}}}
      }}).fetch("data")
    else
      upload = uploads.first
    end
    attributes = upload.fetch("attributes")
    unless attributes.values_at("platform", "cfBundleShortVersionString", "cfBundleVersion") == ["IOS", version, number]
      raise Error, "App Store Connect upload identity differs"
    end
    upload_id = upload.fetch("id")
    state = attributes.dig("state", "state")
    raise Error, "App Store Connect upload failed or has unknown state" unless %w[AWAITING_UPLOAD PROCESSING COMPLETE].include?(state)

    files = fetch_paginated_json("/v1/buildUploads/#{upload_id}/buildUploadFiles", {"limit" => "200"})
    filename = "talaria-#{sha256}.ipa"
    if files.empty? && state == "AWAITING_UPLOAD"
      files = [fetch_json("/v1/buildUploadFiles", method: "POST", body: {data: {
        type: "buildUploadFiles", attributes: {fileName: filename, fileSize: File.size(path), assetType: "ASSET", uti: "com.apple.ipa"},
        relationships: {buildUpload: {data: {type: "buildUploads", id: upload_id}}}
      }}).fetch("data")]
    end
    raise Error, "Missing or ambiguous App Store Connect upload file" unless files.length == 1

    file = files.first
    file_id = file.fetch("id")
    verify_file(file, path, filename, sha256)
    delivery = file.dig("attributes", "assetDeliveryState", "state")
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    if state == "AWAITING_UPLOAD" && delivery == "AWAITING_UPLOAD"
      transfer(path, file.fetch("attributes").fetch("uploadOperations"))
      warn format("TestFlight: transferred %d bytes in %.0f s", File.size(path), Process.clock_gettime(Process::CLOCK_MONOTONIC) - started)
      fetch_json("/v1/buildUploadFiles/#{file_id}", method: "PATCH", body: {data: {
        # Match Apple's upload-testflight-build action: this endpoint rejects
        # optional checksum declarations despite their presence in the schema.
        type: "buildUploadFiles", id: file_id, attributes: {uploaded: true}
      }})
    end

    attempts.times do |attempt|
      current = fetch_json("/v1/buildUploads/#{upload_id}?include=build").fetch("data")
      current_file = fetch_json("/v1/buildUploadFiles/#{file_id}").fetch("data")
      verify_file(current_file, path, filename, sha256)
      state = current.dig("attributes", "state", "state")
      raise Error, "App Store Connect processing failed" unless %w[AWAITING_UPLOAD PROCESSING COMPLETE].include?(state)

      if state == "COMPLETE"
        matching = builds(app, version, number)
        build_id = current.dig("relationships", "build", "data", "id")
        raise Error, "Ambiguous processed builds" if matching.length > 1

        build = matching.first
        if build && build_id
          unless build["id"] == build_id && build.dig("attributes", "version") == number &&
                 %w[PROCESSING VALID].include?(build.dig("attributes", "processingState")) && build.dig("attributes", "expired") == false
            raise Error, "Completed upload does not identify the expected valid build"
          end
          if build.dig("attributes", "processingState") == "VALID" && current_file.dig("attributes", "assetDeliveryState", "state") == "COMPLETE"
            warn format("TestFlight: build %s VALID %.0f s after the transfer began", build_id, Process.clock_gettime(Process::CLOCK_MONOTONIC) - started)
            return {"buildId" => build_id, "uploadId" => upload_id, "ipaSha256" => sha256,
                    "version" => version, "buildNumber" => number.to_i, "processingState" => "VALID"}
          end
        end
      end
      sleep(delay) if attempt + 1 < attempts
    end
    raise Error, "App Store Connect processing is pending; retry this same run and immutable IPA"
  end

  private

  def builds(app, version, number)
    fetch_paginated_json("/v1/builds", {"filter[app]" => app, "filter[preReleaseVersion.version]" => version,
      "filter[version]" => number, "fields[builds]" => "version,processingState,expired", "limit" => "200"})
  end

  def verify_file(file, path, filename, sha256)
    attributes = file.fetch("attributes")
    unless attributes.values_at("fileName", "fileSize", "assetType", "uti") == [filename, File.size(path), "ASSET", "com.apple.ipa"]
      raise Error, "Existing upload file differs from the verified IPA"
    end
    actual = attributes.dig("sourceFileChecksums", "file")
    unless actual.nil?
      unless actual.is_a?(Hash) && %w[MD5 SHA_256].include?(actual["algorithm"])
        raise Error, "Unsupported App Store Connect file checksum"
      end
      expected = actual["algorithm"] == "SHA_256" ? sha256 : Digest::MD5.file(path).hexdigest
      unless actual == {"algorithm" => actual["algorithm"], "hash" => expected}
        raise Error, "Existing upload checksum differs from the verified IPA"
      end
    end
    unless %w[AWAITING_UPLOAD UPLOAD_COMPLETE COMPLETE].include?(attributes.dig("assetDeliveryState", "state"))
      raise Error, "App Store Connect file delivery failed or has unknown state"
    end
  end

  def transfer(path, operations)
    unless operations.all? { |operation| operation["offset"].is_a?(Integer) }
      raise Error, "Invalid App Store Connect upload offset"
    end
    operations = operations.sort_by { |operation| operation.fetch("offset") }
    offset = 0
    operations.each do |operation|
      length = operation.fetch("length")
      url = URI(operation.fetch("url"))
      unless operation["method"] == "PUT" && url.scheme == "https" && url.userinfo.nil? &&
             operation["offset"] == offset && length.is_a?(Integer) && length.positive? && offset + length <= File.size(path)
        raise Error, "Invalid App Store Connect upload operation"
      end
      offset += length
    end
    raise Error, "Incomplete App Store Connect upload operations" unless offset == File.size(path)

    File.open(path, "rb") do |file|
      operations.each do |operation|
        length = operation.fetch("length")
        url = URI(operation.fetch("url"))
        request = Net::HTTP::Put.new(url)
        operation.fetch("requestHeaders", []).each { |header| request[header.fetch("name")] = header.fetch("value") }
        request.body = file.read(length)
        response = Net::HTTP.start(url.hostname, url.port, use_ssl: true, open_timeout: 10, read_timeout: 120) { |http| http.request(request) }
        raise Error, "Build chunk upload failed with HTTP #{response.code}" unless response.is_a?(Net::HTTPSuccess)
      end
    end
  end
end

if $PROGRAM_NAME == __FILE__
  begin
    raise ArgumentError, "usage: upload_testflight.rb IPA VERSION BUILD SHA256" unless ARGV.length == 4

    Tempfile.create(["talaria-asc-", ".p8"], ENV["RUNNER_TEMP"]) do |key|
      key.chmod(0o600)
      key.write(ENV.fetch("APP_STORE_CONNECT_PRIVATE_KEY").gsub('\\n', "\n"))
      key.flush
      env = ENV.to_h.merge("APP_STORE_CONNECT_KEY_PATH" => key.path)
      puts JSON.generate(TestFlightUpload.new(env: env).upload(*ARGV))
    end
  rescue StandardError => error
    warn error.message
    exit 1
  end
end
