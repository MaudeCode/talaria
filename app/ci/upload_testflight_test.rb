# frozen_string_literal: true

require "minitest/autorun"
require "tempfile"
require_relative "upload_testflight"
require_relative "inspect_testflight"

class TestFlightUploadTest < Minitest::Test
  class Apple < TestFlightUpload
    def initialize(remote)
      super()
      @remote = remote
    end

    def app_id_for_bundle_id(bundle)
      raise "wrong bundle" unless bundle == "dev.kil.talaria"
      "synthetic-app"
    end

    def fetch_paginated_json(path, _params)
      case path
      when "/v1/apps/synthetic-app/buildUploads" then [@remote[:upload]].compact * (@remote[:duplicate] ? 2 : 1)
      when %r{/buildUploadFiles$} then [@remote[:file]].compact
      when "/v1/builds"
        @remote[:legacy] || @remote[:upload]&.dig("attributes", "state", "state") == "COMPLETE" ?
          [{"id" => "build-1", "attributes" => {"version" => "7", "processingState" => @remote.fetch(:build_state, "VALID"), "expired" => false}}] : []
      else raise "unexpected GET #{path}"
      end
    end

    def fetch_json(path, method: "GET", body: nil)
      data = body && JSON.parse(JSON.generate(body)).fetch("data")
      case [method, path]
      when ["POST", "/v1/buildUploads"]
        @remote[:creates] = @remote.fetch(:creates, 0) + 1
        @remote[:upload] = data.merge("id" => "upload-1")
        @remote[:upload]["attributes"]["state"] = {"state" => "AWAITING_UPLOAD"}
        @remote[:upload]["relationships"]["build"] = {"data" => {"id" => "build-1"}}
        {"data" => @remote[:upload]}
      when ["POST", "/v1/buildUploadFiles"]
        @remote[:file] = data.merge("id" => "file-1")
        @remote[:file]["attributes"].merge!("assetDeliveryState" => {"state" => "AWAITING_UPLOAD"}, "uploadOperations" => [])
        {"data" => @remote[:file]}
      when ["PATCH", "/v1/buildUploadFiles/file-1"]
        @remote[:file]["attributes"].merge!(data.fetch("attributes"))
        @remote[:file]["attributes"]["assetDeliveryState"] = {"state" => "COMPLETE"}
        @remote[:upload]["attributes"]["state"] = {"state" => "PROCESSING"}
        raise IOError, "response lost after Apple accepted upload" if @remote.delete(:lose_response)
        {"data" => @remote[:file]}
      when ["GET", "/v1/buildUploads/upload-1?include=build"]
        @remote[:upload]["attributes"]["state"] = {"state" => "COMPLETE"} if @remote[:ready]
        {"data" => @remote[:upload]}
      when ["GET", "/v1/buildUploadFiles/file-1"] then {"data" => @remote[:file]}
      else raise "unexpected #{method} #{path}"
      end
    end

    def transfer(_path, _operations)
      @remote[:transfers] = @remote.fetch(:transfers, 0) + 1
    end
  end

  def setup
    @file = Tempfile.new("synthetic-ipa")
    @file.write("synthetic release bytes")
    @file.flush
    @sha = Digest::SHA256.file(@file.path).hexdigest
    @remote = {ready: true}
  end

  def teardown
    @file.close!
  end

  def run_upload
    Apple.new(@remote).upload(@file.path, "1.9.0", "7", @sha, attempts: 1, delay: 0)
  end

  def test_accepted_upload_survives_lost_response_and_lost_receipt
    @remote[:lose_response] = true
    assert_raises(IOError) { run_upload }
    receipt = run_upload
    assert_equal "VALID", receipt["processingState"]
    assert_equal @sha, receipt["ipaSha256"]
    # Discard the successful receipt as if its write or artifact handoff failed.
    assert_equal receipt, run_upload
    assert_equal 1, @remote[:creates]
    assert_equal 1, @remote[:transfers]
  end

  def test_processing_timeout_resumes_without_another_upload
    @remote[:ready] = false
    assert_raises(AppStoreConnectClient::Error) { run_upload }
    @remote[:ready] = true
    assert_equal "build-1", run_upload["buildId"]
    assert_equal 1, @remote[:transfers]
  end

  def test_completed_upload_waits_for_build_processing
    @remote[:build_state] = "PROCESSING"
    assert_raises(AppStoreConnectClient::Error) { run_upload }
    @remote[:build_state] = "VALID"
    assert_equal "build-1", run_upload["buildId"]
    assert_equal 1, @remote[:transfers]
  end

  def test_mismatched_or_ambiguous_remote_artifacts_fail_closed
    run_upload
    good = Marshal.dump(@remote)
    mutations = [
      -> { @remote[:file]["attributes"]["sourceFileChecksums"]["file"]["hash"] = "f" * 64 },
      -> { @remote[:file]["attributes"].delete("sourceFileChecksums") },
      -> { @remote[:file]["attributes"]["fileSize"] += 1 },
      -> { @remote[:file]["attributes"]["fileName"] = "another.ipa" },
      -> { @remote[:file]["attributes"]["assetDeliveryState"]["state"] = "FAILED" },
      -> { @remote[:upload]["attributes"]["cfBundleShortVersionString"] = "1.8.0" },
      -> { @remote[:upload]["relationships"]["build"]["data"]["id"] = "another-build" },
      -> { @remote[:upload]["attributes"]["state"]["state"] = "FAILED" },
      -> { @remote[:duplicate] = true },
      -> { @remote[:build_state] = "INVALID" }
    ]
    mutations.each do |mutate|
      @remote = Marshal.load(good)
      mutate.call
      assert_raises(AppStoreConnectClient::Error) { run_upload }
      assert_equal 1, @remote[:transfers]
    end
  end

  def test_unverified_existing_build_and_changed_local_ipa_cannot_upload
    @remote[:legacy] = true
    assert_raises(AppStoreConnectClient::Error) { run_upload }
    @remote.clear
    @file.write("changed")
    @file.flush
    assert_raises(AppStoreConnectClient::Error) { run_upload }
    assert_nil @remote[:creates]
  end

  def test_api_credentials_cannot_follow_another_origin
    client = AppStoreConnectClient.new
    assert_raises(AppStoreConnectClient::Error) { client.send(:fetch_json, "https://other.example/v1/builds") }
  end

  def test_transfer_sends_exact_bytes_without_api_credentials
    requests = []
    connection = Object.new
    connection.define_singleton_method(:request) do |request|
      requests << request
      Net::HTTPOK.new("1.1", "200", "OK")
    end
    transport = ->(*_args, **_options, &block) { block.call(connection) }
    operations = [{"method" => "PUT", "url" => "https://upload.example/part", "offset" => 0,
                   "length" => File.size(@file.path), "requestHeaders" => [{"name" => "X-Upload", "value" => "synthetic"}]}]
    original = Net::HTTP.method(:start)
    Net::HTTP.define_singleton_method(:start, &transport)
    begin
      TestFlightUpload.new.send(:transfer, @file.path, operations)
      assert_equal File.binread(@file.path), requests.first.body
      assert_equal "synthetic", requests.first["X-Upload"]
      assert_nil requests.first["Authorization"]
      operations.first["offset"] = 1
      assert_raises(AppStoreConnectClient::Error) { TestFlightUpload.new.send(:transfer, @file.path, operations) }
      assert_equal 1, requests.length
    ensure
      Net::HTTP.define_singleton_method(:start, original)
    end
  end

  def test_upload_inspection_is_get_only_and_redacts_transfer_credentials
    operation = {"method" => "POST", "url" => "https://user:secret@upload.example/path-secret?token=query-secret",
                 "offset" => 0, "length" => 12, "requestHeaders" => [{"name" => "X-Key", "value" => "header-secret"}]}
    client = TestFlightInspection.new
    client.define_singleton_method(:app_id_for_bundle_id) { |_bundle| "synthetic-app" }
    calls = []
    client.define_singleton_method(:fetch_paginated_json) do |path, _params|
      calls << path
      if path == "/v1/apps/synthetic-app/buildUploads"
        [{"id" => "synthetic-upload", "attributes" => {"state" => {"state" => "AWAITING_UPLOAD"}}}]
      elsif path == "/v1/buildUploads/synthetic-upload/buildUploadFiles"
        [{"id" => "synthetic-file", "attributes" => {"fileSize" => 12, "uploadOperations" => [operation]}}]
      else
        raise "Unexpected API path"
      end
    end
    # Any mutation or direct request is a failure; only the two paginated GETs above are allowed.
    client.define_singleton_method(:fetch_json) { |*_args, **_kwargs| raise "Unexpected API request" }
    result = client.inspect_upload("1.9.0", "1")
    assert_equal 2, calls.length
    summary = result.first.fetch("files").first.fetch("operations").first
    assert_equal({"method" => "POST", "offset" => 0, "length" => 12, "scheme" => "https",
                  "host" => "upload.example", "hasUserinfo" => true, "offsetType" => "Integer", "lengthType" => "Integer"}, summary)
    refute_includes JSON.generate(result), "secret"
    assert_raises(AppStoreConnectClient::Error) { client.inspect_upload("invalid", "1") }
    assert_equal 2, calls.length
  end
end
