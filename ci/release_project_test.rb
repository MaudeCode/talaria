#!/usr/bin/env ruby
# frozen_string_literal: true

require "minitest/autorun"
require "tempfile"
require_relative "release_project"

class TalariaReleaseProjectTest < Minitest::Test
  PROJECT = <<~PBXPROJ
    MARKETING_VERSION = 1.5;
    CURRENT_PROJECT_VERSION = 7;
    MARKETING_VERSION = 1.5;
    CURRENT_PROJECT_VERSION = 7;
  PBXPROJ

  def test_updates_every_version_assignment
    with_project(PROJECT) do |path|
      project = TalariaReleaseProject.new(path)
      plan = project.plan(requested_version: "v1.6.0", latest_app_store_build: "9")

      project.apply(plan)

      assert_equal({ marketing_version: "1.6.0", build_number: "10" }, project.read_state)
      assert_equal(2, File.read(path).scan("MARKETING_VERSION = 1.6.0;").length)
      assert_equal(2, File.read(path).scan("CURRENT_PROJECT_VERSION = 10;").length)
    end
  end

  def test_dry_run_does_not_write
    with_project(PROJECT) do |path|
      project = TalariaReleaseProject.new(path)
      original = File.read(path)

      project.apply(project.plan(requested_version: "1.6.0"), dry_run: true)

      assert_equal(original, File.read(path))
    end
  end

  def test_rejects_same_version
    with_project(PROJECT) do |path|
      error = assert_raises(ArgumentError) do
        TalariaReleaseProject.new(path).plan(requested_version: "1.5.0")
      end

      assert_includes(error.message, "must be greater")
    end
  end

  def test_rejects_malformed_project_without_writing
    malformed = PROJECT.sub("MARKETING_VERSION = 1.5;", "MARKETING_VERSION = 1.4;")
    with_project(malformed) do |path|
      original = File.read(path)

      assert_raises(ArgumentError) do
        TalariaReleaseProject.new(path).plan(requested_version: "1.6.0")
      end
      assert_equal(original, File.read(path))
    end
  end

  def test_app_store_connect_build_ahead_wins
    with_project(PROJECT) do |path|
      plan = TalariaReleaseProject.new(path).plan(
        requested_version: "1.6.0",
        latest_app_store_build: "22"
      )

      assert_equal("23", plan.new_build_number)
    end
  end

  def test_rejects_malformed_semantic_version
    with_project(PROJECT) do |path|
      assert_raises(ArgumentError) do
        TalariaReleaseProject.new(path).plan(requested_version: "1.6")
      end
    end
  end

  def test_rejects_build_number_regression
    with_project(PROJECT) do |path|
      plan = TalariaReleaseProject.new(path).plan(
        requested_version: "1.6.0",
        latest_app_store_build: "3"
      )

      assert_equal("8", plan.new_build_number)
    end
  end

  private

  def with_project(contents)
    Tempfile.create("project.pbxproj") do |file|
      file.write(contents)
      file.flush
      yield file.path
    end
  end
end
