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
end
