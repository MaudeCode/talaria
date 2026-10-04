import XCTest
@testable import TalariaKit

final class ModelCatalogTests: XCTestCase {
    func testModelsResponseBuildsCatalogGroupsFromUpstreamShape() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let response = try decoder.decode(
            ModelsResponse.self,
            from: Data("""
            {
              "default_model": "@openai:gpt-5.5",
              "active_provider": "openai",
              "groups": [
                {
                  "name": "OpenAI",
                  "provider_id": "openai",
                  "models": [
                    {"id": "@openai:gpt-5.5", "name": "GPT-5.5"},
                    {"id": "@openai:gpt-5.4", "label": "GPT-5.4"}
                  ]
                }
              ]
            }
            """.utf8)
        )

        let groups = response.catalogGroups

        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups.first?.name, "OpenAI")
        XCTAssertEqual(groups.first?.providerID, "openai")
        XCTAssertEqual(groups.first?.models.first?.id, "@openai:gpt-5.5")
        XCTAssertEqual(groups.first?.models.first?.displayName, "GPT-5.5")
        XCTAssertEqual(groups.first?.models.first?.providerID, "openai")
        XCTAssertEqual(response.displayName(for: "@openai:gpt-5.4"), "GPT-5.4")
    }

    func testModelsResponseKeepsExtraModelsForSlashAutocompleteOnly() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let response = try decoder.decode(
            ModelsResponse.self,
            from: Data("""
            {
              "default_model": "@nous:anthropic/claude-opus-4.7",
              "active_provider": "nous",
              "groups": [
                {
                  "name": "Nous (15 of 397)",
                  "provider_id": "nous",
                  "models": [
                    {"id": "@nous:anthropic/claude-opus-4.7", "label": "Claude Opus 4.7 (via Nous)"}
                  ],
                  "extra_models": [
                    {"id": "@nous:qwen/qwen3-coder", "label": "Qwen3 Coder (via Nous)"}
                  ]
                }
              ]
            }
            """.utf8)
        )

        let group = try XCTUnwrap(response.catalogGroups.first)

        XCTAssertEqual(group.models.map(\.id), ["@nous:anthropic/claude-opus-4.7"])
        XCTAssertEqual(group.extraModels.map(\.id), ["@nous:qwen/qwen3-coder"])
        XCTAssertEqual(
            group.slashAutocompleteModels.map(\.id),
            ["@nous:anthropic/claude-opus-4.7", "@nous:qwen/qwen3-coder"]
        )
        XCTAssertEqual(response.displayName(for: "@nous:qwen/qwen3-coder"), "Qwen3 Coder (via Nous)")
    }

    // MARK: - /api/models/live (issue #236)

    func testModelsLiveResponseDecodesUpstreamShape() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let response = try decoder.decode(
            ModelsLiveResponse.self,
            from: Data("""
            {
              "provider": "opencode-go",
              "models": [
                {"id": "kimi-k2.7-code", "label": "Kimi K2.7 Code"}
              ],
              "count": 19
            }
            """.utf8)
        )

        XCTAssertEqual(response.provider, "opencode-go")
        XCTAssertEqual(response.count, 19)

        let options = response.liveOptions
        XCTAssertEqual(options.map(\.id), ["kimi-k2.7-code"])
        XCTAssertEqual(options.first?.displayName, "Kimi K2.7 Code")
        XCTAssertEqual(options.first?.providerID, "opencode-go")
    }

    func testModelsLiveResponseToleratesMissingFields() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let response = try decoder.decode(ModelsLiveResponse.self, from: Data("{}".utf8))

        XCTAssertNil(response.provider)
        XCTAssertNil(response.count)
        XCTAssertTrue(response.liveOptions.isEmpty)
    }

    func testMergingLiveModelsReplacesOnlyTheMatchingProviderGroup() {
        let groups = [
            ModelCatalogGroup(
                id: "opencode-go",
                name: "OpenCode Go",
                providerID: "opencode-go",
                models: [
                    ModelCatalogOption(id: "kept-model", displayName: "Kept Model", providerID: "opencode-go"),
                    ModelCatalogOption(id: "stale-model", displayName: "Stale Model", providerID: "opencode-go")
                ],
                extraModels: [
                    ModelCatalogOption(id: "extra-model", displayName: "Extra Model", providerID: "opencode-go")
                ]
            ),
            ModelCatalogGroup(
                id: "openai",
                name: "OpenAI",
                providerID: "openai",
                models: [
                    ModelCatalogOption(id: "@openai:gpt-5.5", displayName: "GPT-5.5", providerID: "openai")
                ]
            )
        ]

        let live = ModelsLiveResponse(
            provider: "opencode-go",
            models: [
                .object(["id": .string("kept-model"), "label": .string("Kept Model")]),
                .object(["id": .string("kimi-k2.7-code"), "label": .string("Kimi K2.7 Code")])
            ],
            count: 2
        )

        let merged = groups.mergingLiveModels(from: live)

        // Live is authoritative for the matched group: addition shows up, stale model drops.
        XCTAssertEqual(merged.first?.models.map(\.id), ["kept-model", "kimi-k2.7-code"])
        XCTAssertEqual(merged.first?.models.last?.displayName, "Kimi K2.7 Code")
        XCTAssertEqual(merged.first?.models.last?.providerID, "opencode-go")
        XCTAssertEqual(merged.first?.id, "opencode-go")
        XCTAssertEqual(merged.first?.name, "OpenCode Go")
        XCTAssertEqual(merged.first?.extraModels.map(\.id), ["extra-model"])
        XCTAssertEqual(merged.last, groups.last)
    }

    func testMergingLiveModelsLeavesGroupsUnchangedWhenNoGroupMatches() {
        let groups = [
            ModelCatalogGroup(
                id: "openai",
                name: "OpenAI",
                providerID: "openai",
                models: [
                    ModelCatalogOption(id: "@openai:gpt-5.5", displayName: "GPT-5.5", providerID: "openai")
                ]
            )
        ]

        let live = ModelsLiveResponse(
            provider: "unknown-provider",
            models: [.object(["id": .string("some-model"), "label": .string("Some Model")])],
            count: 1
        )

        XCTAssertEqual(groups.mergingLiveModels(from: live), groups)
    }

    func testMergingLiveModelsLeavesGroupsUnchangedOnDegenerateResponses() {
        let groups = [
            ModelCatalogGroup(
                id: "opencode-go",
                name: "OpenCode Go",
                providerID: "opencode-go",
                models: [
                    ModelCatalogOption(id: "kept-model", displayName: "Kept Model", providerID: "opencode-go")
                ]
            )
        ]

        // Missing provider.
        XCTAssertEqual(
            groups.mergingLiveModels(from: ModelsLiveResponse(provider: nil, models: [], count: nil)),
            groups
        )

        // Whitespace-only provider.
        XCTAssertEqual(
            groups.mergingLiveModels(from: ModelsLiveResponse(provider: "  ", models: [], count: nil)),
            groups
        )

        // Matching provider but an empty live list must not blank out the cached group.
        XCTAssertEqual(
            groups.mergingLiveModels(from: ModelsLiveResponse(provider: "opencode-go", models: [], count: 0)),
            groups
        )

        // Entries without usable ids parse to nothing and are treated as empty.
        XCTAssertEqual(
            groups.mergingLiveModels(
                from: ModelsLiveResponse(
                    provider: "opencode-go",
                    models: [.object(["label": .string("No ID")])],
                    count: 1
                )
            ),
            groups
        )
    }
    /// TAL-301: `/api/models` as the server serves it, with colon-bearing ids
    /// and one bare id under two providers, every entry stamped with the
    /// server's `provider_id`/`bare_id` split.
    private func colonCatalog() throws -> ModelsResponse {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(ModelsResponse.self, from: Data("""
        {
          "default_model": "@custom:localhost:8080:m",
          "default_provider_id": "custom:localhost:8080",
          "default_bare_id": "m",
          "default_option_id": "@custom:localhost:8080:m",
          "active_provider": "anthropic",
          "groups": [
            {"name": "Anthropic", "provider_id": "anthropic", "models": [
              {"id": "claude-opus-4.7", "label": "Claude Opus 4.7", "provider_id": "anthropic", "bare_id": "claude-opus-4.7"},
              {"id": "@custom:localhost:8080:m", "label": "Local M", "provider_id": "custom:localhost:8080", "bare_id": "m"}
            ]},
            {"name": "Gemini", "provider_id": "gemini", "models": [
              {"id": "@gemini:gemini-2.5-flash", "label": "Flash via Gemini", "provider_id": "gemini", "bare_id": "gemini-2.5-flash"}
            ]},
            {"name": "Google", "provider_id": "google", "models": [
              {"id": "@google:gemini-2.5-flash", "label": "Flash via Google", "provider_id": "google", "bare_id": "gemini-2.5-flash"}
            ]},
            {"name": "Ollama", "provider_id": "ollama", "models": [
              {"id": "@ollama:llama3:8b", "label": "Llama3 8B", "provider_id": "ollama", "bare_id": "llama3:8b"}
            ]}
          ]
        }
        """.utf8))
    }

    /// A stamped catalog ticks exactly the entry the server names for the
    /// stored pair; the app never re-pairs `(model, provider)` itself.
    func testServerOptionIDTicksExactlyOneEntryOfAStampedCatalog() throws {
        let options = try colonCatalog().catalogGroups.flatMap(\.models)
        let cases: [(String, String, String)] = [
            ("llama3:8b", "ollama", "@ollama:llama3:8b"),
            ("m", "custom:localhost:8080", "@custom:localhost:8080:m"),
            ("gemini-2.5-flash", "gemini", "@gemini:gemini-2.5-flash"),
            ("gemini-2.5-flash", "google", "@google:gemini-2.5-flash"),
            ("claude-opus-4.7", "anthropic", "claude-opus-4.7")
        ]
        for (model, provider, optionID) in cases {
            let selected = options.filter { $0.isSelected(optionID: optionID, modelID: model, providerID: provider) }
            XCTAssertEqual(selected.map(\.id), [optionID], "\(model) / \(provider)")
            XCTAssertEqual(selected.first?.providerID, provider)
        }
        // The server paired nothing: no entry ticks, even one with the same id.
        XCTAssertNil(options.firstSelected(optionID: nil, modelID: "claude-opus-4.7", providerID: "anthropic"))
    }

    func testModelsResponseDecodesTheServerSelectedDefault() throws {
        let response = try colonCatalog()
        XCTAssertEqual(response.defaultOptionID, "@custom:localhost:8080:m")
        let options = response.catalogGroups.flatMap(\.models)
        let checked = options.filter {
            DefaultModelPickerSelection.isChecked(
                $0,
                selectedModel: nil,
                selectedProvider: nil,
                defaultOptionID: response.defaultOptionID,
                defaultModel: response.defaultModel
            )
        }
        XCTAssertEqual(checked.map(\.id), ["@custom:localhost:8080:m"])
    }

    /// An older server stamps nothing: an entry matches its exact id only, and
    /// a provider named on both sides still has to agree.
    func testUnstampedEntryMatchesItsExactIDOnly() {
        let prefixed = ModelCatalogOption(id: "@gemini:flash", displayName: "Prefixed", providerID: "gemini")
        let bare = ModelCatalogOption(id: "flash", displayName: "Bare", providerID: "gemini")

        XCTAssertTrue(prefixed.isSelected(optionID: nil, modelID: "@gemini:flash", providerID: nil))
        XCTAssertTrue(prefixed.isSelected(optionID: nil, modelID: "@gemini:flash", providerID: "gemini"))
        XCTAssertFalse(prefixed.isSelected(optionID: nil, modelID: "flash", providerID: "gemini"))
        XCTAssertFalse(bare.isSelected(optionID: nil, modelID: "flash", providerID: "google"))
        XCTAssertTrue(bare.isSelected(optionID: nil, modelID: "flash", providerID: "gemini"))
        XCTAssertEqual([prefixed, bare].firstSelected(optionID: nil, modelID: "flash", providerID: nil)?.displayName, "Bare")
    }

    /// A tap records the row's id and provider. The previous stored default
    /// must not stay checkmarked / Selected while the save is in flight.
    func testPickerInFlightSelectionTicksOnlyTheTappedProviderRow() throws {
        let response = try colonCatalog()
        let options = response.catalogGroups.flatMap(\.models)
        let checked = options.filter {
            DefaultModelPickerSelection.isChecked(
                $0,
                selectedModel: "@google:gemini-2.5-flash",
                selectedProvider: "google",
                defaultOptionID: response.defaultOptionID,
                defaultModel: response.defaultModel
            )
        }
        XCTAssertEqual(checked.map(\.id), ["@google:gemini-2.5-flash"])
    }

    /// A custom save records the typed id with no provider. That must not
    /// tick a same-id catalog row while the request is in flight.
    func testPickerCustomSaveDoesNotTickCatalogRows() throws {
        let response = try colonCatalog()
        XCTAssertFalse(response.catalogGroups.flatMap(\.models).contains {
            DefaultModelPickerSelection.isChecked(
                $0,
                selectedModel: "claude-opus-4.7",
                selectedProvider: nil,
                defaultOptionID: response.defaultOptionID,
                defaultModel: response.defaultModel
            )
        })
    }

}

final class PersonalityAutocompleteTests: XCTestCase {
    func testSlashAutocompleteNamesPrependsNoneAndDeduplicates() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let response = try decoder.decode(
            PersonalitiesResponse.self,
            from: Data("""
            {
              "personalities": [
                {"name": "mentor", "description": "Patient technical coach"},
                {"name": "none", "description": "Should not duplicate the clear option"},
                {"name": "critic"},
                {"name": "   "}
              ]
            }
            """.utf8)
        )

        XCTAssertEqual(response.slashAutocompleteNames, ["none", "mentor", "critic"])
    }
}
