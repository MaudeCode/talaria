#!/usr/bin/env ruby
# frozen_string_literal: true

require_relative "app_store_connect"

class TestFlightBuildNumberSelector < AppStoreConnectClient
  BUILD_NUMBER_PATTERN = /\A\d+(?:\.\d+)*\z/

  # App Store version states in which Apple has approved the version and closed
  # its pre-release train: any later upload must carry a higher
  # CFBundleShortVersionString (ASC upload errors 90186/90062, hit on
  # 2026-06-02 with 1.0 and again on 2026-08-04 with 1.4).
  APPROVED_APP_STORE_STATES = %w[
    READY_FOR_SALE
    READY_FOR_DISTRIBUTION
    PENDING_DEVELOPER_RELEASE
    PENDING_APPLE_RELEASE
    PROCESSING_FOR_APP_STORE
  ].freeze

  SelectionError = AppStoreConnectClient::Error

  def self.valid_build_number?(value)
    BUILD_NUMBER_PATTERN.match?(value.to_s)
  end

  def self.compare_build_numbers(left, right)
    validate_build_number!(left, "left build number")
    validate_build_number!(right, "right build number")

    left_parts = left.split(".").map(&:to_i)
    right_parts = right.split(".").map(&:to_i)
    max_length = [left_parts.length, right_parts.length].max

    max_length.times do |index|
      left_value = left_parts[index] || 0
      right_value = right_parts[index] || 0
      return -1 if left_value < right_value
      return 1 if left_value > right_value
    end

    0
  end

  def self.increment_build_number(value)
    validate_build_number!(value, "latest build number")

    parts = value.split(".").map(&:to_i)
    parts[-1] += 1
    parts.join(".")
  end

  def self.select_build_number(requested_build_number:, latest_build_number:)
    requested = requested_build_number.to_s.strip

    unless requested.empty?
      validate_build_number!(requested, "requested build number")

      if latest_build_number && compare_build_numbers(requested, latest_build_number) <= 0
        raise SelectionError,
              "Requested build number #{requested} must be greater than latest App Store Connect build #{latest_build_number}."
      end

      return requested
    end

    latest_build_number ? increment_build_number(latest_build_number) : "1"
  end

  # Returns the approved App Store version that closes the train for
  # marketing_version, or nil when the train is open. Approved version strings
  # that are not plain dotted numerics cannot be compared and are ignored.
  def self.closed_train_version(marketing_version:, approved_versions:)
    validate_build_number!(marketing_version, "marketing version")

    approved_versions
      .select { |value| valid_build_number?(value) }
      .find { |value| compare_build_numbers(marketing_version, value) <= 0 }
  end

  def self.validate_build_number!(value, label)
    return if valid_build_number?(value)

    raise SelectionError, "#{label.capitalize} must contain only digits and dots. Received: #{value}"
  end

  def run
    bundle_id = required_env("BUNDLE_ID")
    marketing_version = required_env("MARKETING_VERSION")
    requested_build_number = @env.fetch("REQUESTED_BUILD_NUMBER", "")

    enforce_open_train!(bundle_id: bundle_id, marketing_version: marketing_version) if @env["ENFORCE_OPEN_TRAIN"] == "1"

    latest = latest_uploaded_build_number(bundle_id: bundle_id, marketing_version: marketing_version)
    selected = self.class.select_build_number(
      requested_build_number: requested_build_number,
      latest_build_number: latest
    )

    if requested_build_number.to_s.strip.empty?
      warn "Latest App Store Connect build for #{bundle_id} #{marketing_version}: #{latest || "none"}"
      warn "Selected next build number: #{selected}"
    else
      warn "Latest App Store Connect build for #{bundle_id} #{marketing_version}: #{latest || "none"}"
      warn "Using requested build number: #{selected}"
    end

    selected
  end

  def ensure_open_train!(bundle_id:, marketing_version:)
    enforce_open_train!(bundle_id: bundle_id, marketing_version: marketing_version)
  end

  def latest_build_number(bundle_id:, marketing_version:)
    latest_uploaded_build_number(bundle_id: bundle_id, marketing_version: marketing_version)
  end

  private

  # Fails fast — before the ~15-minute archive step — when App Store Connect
  # would reject the upload anyway because marketing_version's pre-release
  # train is closed by an approved App Store version.
  def enforce_open_train!(bundle_id:, marketing_version:)
    blocking = self.class.closed_train_version(
      marketing_version: marketing_version,
      approved_versions: approved_app_store_versions(bundle_id: bundle_id)
    )

    if blocking
      raise SelectionError,
            "The #{marketing_version} pre-release train is closed: App Store version #{blocking} is already approved. " \
            "Push a signed semantic release tag above #{blocking}."
    end

    warn "Pre-release train #{marketing_version} is open: no approved App Store version at or above it."
  end

  def approved_app_store_versions(bundle_id:)
    app_id = app_id_for_bundle_id(bundle_id)
    versions = fetch_paginated_json(
      "/v1/apps/#{app_id}/appStoreVersions",
      "fields[appStoreVersions]" => "versionString,appStoreState",
      "limit" => "200"
    )

    versions
      .select { |item| APPROVED_APP_STORE_STATES.include?(item.dig("attributes", "appStoreState")) }
      .map { |item| item.dig("attributes", "versionString") }
      .compact
  end

  def latest_uploaded_build_number(bundle_id:, marketing_version:)
    app_id = app_id_for_bundle_id(bundle_id)
    builds = fetch_paginated_json(
      "/v1/builds",
      "filter[app]" => app_id,
      "filter[preReleaseVersion.version]" => marketing_version,
      "fields[builds]" => "version,uploadedDate",
      "limit" => "200"
    )

    build_numbers = builds.map { |item| item.dig("attributes", "version") }.compact
    invalid_build_numbers = build_numbers.reject { |value| self.class.valid_build_number?(value) }
    unless invalid_build_numbers.empty?
      raise SelectionError,
            "Cannot auto-select after non-numeric App Store Connect build numbers: #{invalid_build_numbers.uniq.join(", ")}"
    end

    build_numbers.max { |left, right| self.class.compare_build_numbers(left, right) }
  end


end

if $PROGRAM_NAME == __FILE__
  begin
    puts TestFlightBuildNumberSelector.new.run
  rescue TestFlightBuildNumberSelector::SelectionError => error
    warn error.message
    exit 1
  end
end
