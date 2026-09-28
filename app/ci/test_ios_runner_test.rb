#!/usr/bin/env ruby
# frozen_string_literal: true

require "minitest/autorun"

class TestIOSRunnerTest < Minitest::Test
  def test_disables_slow_xcode_failure_diagnostics
    script = File.read(File.expand_path("../scripts/test-ios", __dir__))

    assert_includes(script, "-collect-test-diagnostics never")
  end

  def test_single_worker_runs_on_the_leased_simulator_without_cloning
    script = File.read(File.expand_path("../scripts/test-ios", __dir__))

    # A clone per run races the previous run's clone teardown on the same leased device.
    assert_match(/\(\( TALARIA_TEST_WORKER_COUNT > 1 \)\) && parallel_testing=YES/, script)
    assert_includes(script, '-parallel-testing-enabled "$parallel_testing"')
  end

  def test_pr_ci_uses_a_unique_simulator_destination
    workflow = File.read(
      File.expand_path("../../.github/workflows/pr-ci.yml", __dir__),
      encoding: "UTF-8"
    )

    # Build, shard suite and live contract test all target the simulator select-ios-simulator chose or created.
    assert_equal(2, workflow.scan("simulator_id=$(scripts/select-ios-simulator | cut -f1)").length)
    assert_includes(workflow, "IOS_SIMULATOR_DEVICE_TYPE=com.apple.CoreSimulator.SimDeviceType.iPhone-17")
    assert_equal(3, workflow.scan('platform=iOS Simulator,id=${SIMULATOR_ID}').length)
    refute_includes(workflow, "platform=iOS Simulator,name=${SIMULATOR_NAME}")
  end

  def test_unit_tests_never_request_real_live_activities
    # A test host that requests real Live Activities leaves them on the simulator,
    # and the next host launch there fails with "No such process" or hangs (TAL-375).
    spy = /Spy\w*LiveActivityManager/
    constructions = Dir[File.expand_path("../TalariaTests/**/*.swift", __dir__)].flat_map do |path|
      source = File.read(path, encoding: "UTF-8")
      source.enum_for(:scan, /^(\s*)(?:let \w+ = |return )ChatViewModel\((.*?)\n\1\)/m).map do
        match = Regexp.last_match
        enclosing_function = source[0...match.begin(0)][/.*\bfunc .*/m].to_s.split(/\bfunc /).last.to_s
        [File.basename(path), enclosing_function, match[2][/liveActivityManager: ([^,\n]+)/, 1]]
      end
    end

    assert_operator(constructions.length, :>=, 10)
    constructions.each do |file, enclosing_function, manager|
      # A nil or omitted manager resolves to the shared production manager.
      test_double = manager&.match?(/\A(?:liveActivityManager \?\? )?#{spy}\(\)\z/) ||
        (manager&.match?(/\A\w+\z/) && enclosing_function.match?(/\b#{manager}(?: = |: )#{spy}\b/))
      assert(test_double, "#{file} builds a ChatViewModel with #{manager || "the default"} Live Activity manager")
    end

    workflow = File.read(File.expand_path("../../.github/workflows/pr-ci.yml", __dir__), encoding: "UTF-8")
    live_step = workflow[/- name: Run the live Web contract test.*?(?=\n      - name: )/m]
    refute_includes(live_step, "xcrun simctl")
  end

  def test_pr_ci_shards_run_one_worker_without_clones
    workflow = File.read(
      File.expand_path("../../.github/workflows/pr-ci.yml", __dir__),
      encoding: "UTF-8"
    )
    shards = File.read(File.expand_path("test_shards.py", __dir__), encoding: "UTF-8")
    ui_tests = File.read(
      File.expand_path("../TalariaUITests/TalariaUITests.swift", __dir__),
      encoding: "UTF-8"
    )

    # Every shard owns one simulator and runs one worker on it; the scheme stays parallelizable for local runs.
    assert_equal(2, workflow.scan("-parallel-testing-enabled NO").length)
    refute_includes(workflow, "-parallel-testing-enabled YES")
    assert_includes(workflow, "shards='[0,1,2,3]'")
    assert_includes(workflow, "shards='[0,1]'")
    assert_includes(workflow, 'python3 ci/test_shards.py "${options[@]}" > selection.txt')
    assert_equal(26, ui_tests.scan(/final class \w+UITests: \w+UITestCase/).length)
    # CI skips the measurement-only UI classes and the scheduled UI Performance
    # workflow runs them (TAL-75, TAL-287); the shard script owns the skip list.
    %w[
      SidebarPerformanceUITests
      LaunchPerformanceUITests
      TranscriptPerformanceUITests
      NavigationPerformanceUITests
    ].each do |performance_class|
      assert_includes(shards, "TalariaUITests/#{performance_class}")
    end
    assert_includes(workflow, "scripts/report-performance-metrics")
    reporter = File.read(File.expand_path("../scripts/report-performance-metrics", __dir__), encoding: "UTF-8")
    assert_includes(reporter, '"xcresulttool", "get", "test-results", "metrics"')
  end
end
