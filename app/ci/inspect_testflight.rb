#!/usr/bin/env ruby
# frozen_string_literal: true

require "tempfile"
require_relative "app_store_connect"

# GET-only diagnostics: upload URLs and request headers are bearer credentials.
class TestFlightInspection < AppStoreConnectClient
  def inspect_upload(version, number)
    unless version.match?(/\A\d+\.\d+\.\d+\z/) && number.match?(/\A[1-9]\d*\z/)
      raise Error, "Invalid TestFlight version or build number"
    end
    app = app_id_for_bundle_id("dev.kil.talaria")
    uploads = fetch_paginated_json("/v1/apps/#{app}/buildUploads", {
      "filter[cfBundleShortVersionString]" => version, "filter[cfBundleVersion]" => number,
      "filter[platform]" => "IOS", "limit" => "200"
    })
    uploads.map do |upload|
      files = fetch_paginated_json("/v1/buildUploads/#{upload.fetch('id')}/buildUploadFiles", {"limit" => "200"})
      {"id" => upload.fetch("id"), "state" => upload.dig("attributes", "state", "state"),
       "files" => files.map do |file|
         attributes = file.fetch("attributes")
         {"id" => file.fetch("id"), "fileSize" => attributes["fileSize"],
          "state" => attributes.dig("assetDeliveryState", "state"),
          "operations" => attributes.fetch("uploadOperations", []).map { |operation| self.class.operation_summary(operation) }}
       end}
    end
  end

  def self.operation_summary(operation)
    url = URI(operation.fetch("url"))
    operation.slice("method", "offset", "length").merge(
      "scheme" => url.scheme, "host" => url.host, "hasUserinfo" => !url.userinfo.nil?,
      "offsetType" => operation["offset"].class.name, "lengthType" => operation["length"].class.name
    )
  end
end

if $PROGRAM_NAME == __FILE__
  begin
    raise ArgumentError unless ARGV.length == 2

    Tempfile.create(["talaria-asc-", ".p8"], ENV["RUNNER_TEMP"]) do |key|
      key.chmod(0o600)
      key.write(ENV.fetch("APP_STORE_CONNECT_PRIVATE_KEY").gsub('\\n', "\n"))
      key.flush
      env = ENV.to_h.merge("APP_STORE_CONNECT_KEY_PATH" => key.path)
      puts JSON.pretty_generate(TestFlightInspection.new(env: env).inspect_upload(*ARGV))
    end
  rescue StandardError => error
    # URI/API exceptions can embed the rejected URL or remote response.
    warn "TestFlight inspection failed (#{error.class})"
    exit 1
  end
end
