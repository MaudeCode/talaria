#!/usr/bin/env ruby
# frozen_string_literal: true

require "base64"
require "json"
require "net/http"
require "openssl"
require "time"
require "uri"

class AppStoreConnectClient
  API_BASE = "https://api.appstoreconnect.apple.com"
  class Error < StandardError; end

  def initialize(env: ENV, now: nil)
    @env = env
    @now = now
    @jwt_token = nil
  end

  private

  # Memoized: the train preflight and build-number selection both need it.
  def app_id_for_bundle_id(bundle_id)
    @app_ids ||= {}
    cached = @app_ids[bundle_id]
    return cached if cached

    @app_ids[bundle_id] = uncached_app_id_for_bundle_id(bundle_id)
  end

  def uncached_app_id_for_bundle_id(bundle_id)
    apps = fetch_paginated_json(
      "/v1/apps",
      "filter[bundleId]" => bundle_id,
      "fields[apps]" => "bundleId,name,sku",
      "limit" => "10"
    )

    app = apps.find { |item| item.dig("attributes", "bundleId") == bundle_id }
    raise Error, "No App Store Connect app found for bundle ID #{bundle_id}." unless app

    app.fetch("id")
  end

  def fetch_paginated_json(path, params)
    url = URI.join(API_BASE, path)
    url.query = URI.encode_www_form(params)
    items = []

    loop do
      response = fetch_json(url)
      data = response.fetch("data")
      raise Error, "Expected App Store Connect data array from #{url}." unless data.is_a?(Array)

      items.concat(data)
      next_url = response.dig("links", "next")
      break if next_url.to_s.empty?

      url = URI(next_url)
    end

    items
  end

  def fetch_json(url, method: "GET", body: nil)
    url = URI.join(API_BASE, url.to_s)
    unless url.scheme == "https" && url.host == "api.appstoreconnect.apple.com" && url.port == 443 && url.userinfo.nil?
      raise Error, "Refusing App Store Connect credentials for another origin"
    end
    request = {"GET" => Net::HTTP::Get, "POST" => Net::HTTP::Post, "PATCH" => Net::HTTP::Patch}.fetch(method).new(url)
    if body
      request["Content-Type"] = "application/json"
      request.body = JSON.generate(body)
    end
    request["Authorization"] = "Bearer #{jwt_token}"
    request["Accept"] = "application/json"

    response = Net::HTTP.start(
      url.hostname,
      url.port,
      use_ssl: url.scheme == "https",
      open_timeout: 10,
      read_timeout: 30
    ) do |http|
      http.request(request)
    end

    unless response.is_a?(Net::HTTPSuccess)
      raise Error, "App Store Connect request failed with HTTP #{response.code}: #{response.body}"
    end

    JSON.parse(response.body)
  rescue JSON::ParserError => error
    raise Error, "App Store Connect returned invalid JSON: #{error.message}"
  end

  def jwt_token
    now = (@now || Time.now).to_i
    return @jwt_token if @jwt_token && now < @jwt_expires_at - 60

    @jwt_token = begin
      issued_at = now - 60
      @jwt_expires_at = issued_at + (20 * 60)
      header = {
        alg: "ES256",
        kid: required_env("APP_STORE_CONNECT_KEY_ID"),
        typ: "JWT"
      }
      payload = {
        iss: required_env("APP_STORE_CONNECT_ISSUER_ID"),
        iat: issued_at,
        exp: issued_at + (20 * 60),
        aud: "appstoreconnect-v1"
      }

      signing_input = [base64url(header.to_json), base64url(payload.to_json)].join(".")
      signature = base64url(es256_signature(signing_input))
      "#{signing_input}.#{signature}"
    end
  end

  def es256_signature(signing_input)
    key = OpenSSL::PKey.read(File.read(required_env("APP_STORE_CONNECT_KEY_PATH")))
    der_signature = key.sign(OpenSSL::Digest::SHA256.new, signing_input)
    sequence = OpenSSL::ASN1.decode(der_signature)

    r = sequence.value[0].value.to_i
    s = sequence.value[1].value.to_i
    hex_signature = [r.to_s(16).rjust(64, "0"), s.to_s(16).rjust(64, "0")].join
    [hex_signature].pack("H*")
  end

  def base64url(value)
    Base64.strict_encode64(value).tr("+/", "-_").delete("=")
  end

  def required_env(name)
    value = @env[name].to_s
    raise Error, "Missing required environment variable: #{name}" if value.empty?

    value
  end
end
