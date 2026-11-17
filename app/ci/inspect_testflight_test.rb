# frozen_string_literal: true

require "minitest/autorun"
require_relative "inspect_testflight"

# The read-only TestFlight inspection keeps the App Store Connect client; publishing goes through the shared iOS actions.
class TestFlightInspectionTest < Minitest::Test
  def test_api_credentials_cannot_follow_another_origin
    client = AppStoreConnectClient.new
    assert_raises(AppStoreConnectClient::Error) { client.send(:fetch_json, "https://other.example/v1/builds") }
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
