#!/usr/bin/env ruby
# frozen_string_literal: true

require_relative "select_testflight_build_number"

class TalariaReleaseProject
  PROJECT_PATH = "Talaria.xcodeproj/project.pbxproj"
  SEMVER_PATTERN = /\A(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\z/
  STORED_VERSION_PATTERN = /\A\d+(?:\.\d+){1,2}\z/
  ASSIGNMENT_PATTERN = /^(\s*)(MARKETING_VERSION|CURRENT_PROJECT_VERSION) = ([^;]+);$/

  Plan = Struct.new(
    :old_marketing_version,
    :new_marketing_version,
    :old_build_number,
    :new_build_number,
    :latest_app_store_build,
    keyword_init: true
  )

  def initialize(path = PROJECT_PATH)
    @path = path
  end

  def plan(requested_version:, latest_app_store_build: nil)
    requested = normalize_requested_version(requested_version)
    state = read_state

    unless compare_versions(requested, state.fetch(:marketing_version)).positive?
      raise ArgumentError,
            "Requested version #{requested} must be greater than current version #{state.fetch(:marketing_version)}."
    end

    latest = latest_app_store_build.to_s.strip
    latest = nil if latest.empty?
    if latest && !TestFlightBuildNumberSelector.valid_build_number?(latest)
      raise ArgumentError, "Latest App Store Connect build is invalid: #{latest}"
    end

    baseline = [state.fetch(:build_number), latest].compact.max do |left, right|
      TestFlightBuildNumberSelector.compare_build_numbers(left, right)
    end

    Plan.new(
      old_marketing_version: state.fetch(:marketing_version),
      new_marketing_version: requested,
      old_build_number: state.fetch(:build_number),
      new_build_number: TestFlightBuildNumberSelector.increment_build_number(baseline),
      latest_app_store_build: latest
    )
  end

  def apply(plan, dry_run: false)
    return if dry_run

    contents = File.read(@path)
    updated = contents.gsub(ASSIGNMENT_PATTERN) do
      indentation = Regexp.last_match(1)
      key = Regexp.last_match(2)
      value = key == "MARKETING_VERSION" ? plan.new_marketing_version : plan.new_build_number
      "#{indentation}#{key} = #{value};"
    end
    File.write(@path, updated)

    state = read_state
    return if state.fetch(:marketing_version) == plan.new_marketing_version &&
              state.fetch(:build_number) == plan.new_build_number

    raise "Release project update did not produce the requested version and build."
  end

  def read_state
    values = Hash.new { |hash, key| hash[key] = [] }
    File.foreach(@path) do |line|
      match = ASSIGNMENT_PATTERN.match(line)
      values[match[2]] << match[3].strip if match
    end

    marketing_version = one_value!(values.fetch("MARKETING_VERSION"), "MARKETING_VERSION")
    build_number = one_value!(values.fetch("CURRENT_PROJECT_VERSION"), "CURRENT_PROJECT_VERSION")

    unless STORED_VERSION_PATTERN.match?(marketing_version)
      raise ArgumentError, "MARKETING_VERSION is invalid: #{marketing_version}"
    end
    unless TestFlightBuildNumberSelector.valid_build_number?(build_number)
      raise ArgumentError, "CURRENT_PROJECT_VERSION is invalid: #{build_number}"
    end

    { marketing_version: marketing_version, build_number: build_number }
  end

  def normalize_requested_version(value)
    normalized = value.to_s.sub(/\Av/, "")
    return normalized if SEMVER_PATTERN.match?(normalized)

    raise ArgumentError, "Release version must use X.Y.Z numeric semantic versioning. Received: #{value}"
  end

  private

  def one_value!(values, key)
    raise ArgumentError, "No #{key} assignments found in #{@path}." if values.empty?

    unique = values.uniq
    return unique.first if unique.length == 1

    raise ArgumentError, "#{key} is inconsistent across build configurations: #{unique.join(', ')}"
  end

  def compare_versions(left, right)
    left_parts = left.split(".").map(&:to_i)
    right_parts = right.split(".").map(&:to_i)
    right_parts << 0 until right_parts.length == 3
    left_parts <=> right_parts
  end
end
