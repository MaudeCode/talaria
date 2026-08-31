#!/usr/bin/env ruby
# frozen_string_literal: true

require "minitest/autorun"

class TestIOSRunnerTest < Minitest::Test
  def test_disables_slow_xcode_failure_diagnostics
    script = File.read(File.expand_path("../scripts/test-ios", __dir__))

    assert_includes(script, "-collect-test-diagnostics never")
  end

  def test_pr_ci_uses_a_unique_simulator_destination
    workflow = File.read(
      File.expand_path("../.github/workflows/pr-ci.yml", __dir__),
      encoding: "UTF-8"
    )

    assert_includes(workflow, 'selected["udid"]')
    assert_equal(2, workflow.scan('platform=iOS Simulator,id=${SIMULATOR_ID}').length)
    refute_includes(workflow, "platform=iOS Simulator,name=${SIMULATOR_NAME}")
  end

  def test_pr_ci_runs_ui_tests_with_three_workers
    workflow = File.read(
      File.expand_path("../.github/workflows/pr-ci.yml", __dir__),
      encoding: "UTF-8"
    )
    scheme = File.read(
      File.expand_path("../Talaria.xcodeproj/xcshareddata/xcschemes/Talaria.xcscheme", __dir__),
      encoding: "UTF-8"
    )
    ui_tests = File.read(
      File.expand_path("../TalariaUITests/TalariaUITests.swift", __dir__),
      encoding: "UTF-8"
    )

    ui_testable = scheme.scan(/<TestableReference.*?<\/TestableReference>/m).find do |testable|
      testable.include?('BlueprintName = "TalariaUITests"')
    end

    assert_includes(workflow, "TEST_WORKER_COUNT: 3")
    assert_includes(ui_testable, 'parallelizable = "YES"')
    assert_equal(15, ui_tests.scan(/final class \w+UITests: \w+UITestCase/).length)
    assert_includes(workflow, "-skip-testing:TalariaUITests/SidebarPerformanceUITests")
  end
end
