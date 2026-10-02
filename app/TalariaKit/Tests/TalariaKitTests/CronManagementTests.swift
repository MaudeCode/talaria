import XCTest
@testable import TalariaKit

final class CronManagementModelTests: XCTestCase {
    func testCronMutationResponseDecodesAliasesAndStringSchedule() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase

        let response = try decoder.decode(
            CronMutationResponse.self,
            from: Data("""
            {
              "ok": true,
              "job": {
                "job_id": "job-aliased",
                "name": "Aliased task",
                "prompt": 42,
                "schedule": "0 9 * * *",
                "enabled": "true",
                "state": "scheduled",
                "model": "@openai:gpt-5.5",
                "profile": "work",
                "toast_notifications": "yes"
              }
            }
            """.utf8)
        )

        let job = try XCTUnwrap(response.job)
        XCTAssertEqual(job.jobId, "job-aliased")
        XCTAssertEqual(job.prompt, "42")
        XCTAssertEqual(job.scheduleText, "0 9 * * *")
        XCTAssertEqual(job.status, .active)
        XCTAssertEqual(job.model, "@openai:gpt-5.5")
        XCTAssertEqual(job.profile, "work")
        XCTAssertEqual(job.toastNotifications, true)
    }

    func testCronJobEditorDraftNormalizesFieldsAndSkills() {
        let draft = CronJobEditorDraft(
            name: "  Morning digest  ",
            prompt: "  Summarize updates  ",
            schedule: "  0 7 * * *  ",
            deliver: "  local  ",
            skillsText: "summarize, notify\nswift",
            model: "  @openai:gpt-5.5  ",
            provider: "  openai  ",
            profile: "  work  ",
            toastNotifications: true
        )

        XCTAssertEqual(draft.trimmedName, "Morning digest")
        XCTAssertEqual(draft.trimmedPrompt, "Summarize updates")
        XCTAssertEqual(draft.trimmedSchedule, "0 7 * * *")
        XCTAssertEqual(draft.trimmedDeliver, "local")
        XCTAssertEqual(draft.skills, ["summarize", "notify", "swift"])
        XCTAssertEqual(draft.trimmedModel, "@openai:gpt-5.5")
        XCTAssertEqual(draft.trimmedProvider, "openai")
        XCTAssertEqual(draft.trimmedProfile, "work")
        XCTAssertNil(draft.validationMessage)
    }

    func testCronJobEditorDraftRoundTripsUnknownDeliverAndProvider() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let job = try decoder.decode(
            CronJob.self,
            from: Data("""
            {
              "id": "job-legacy",
              "prompt": "Run it",
              "schedule": "0 7 * * *",
              "deliver": "legacy-target",
              "provider": "openai"
            }
            """.utf8)
        )

        let draft = CronJobEditorDraft(job: job)

        XCTAssertEqual(draft.deliver, "legacy-target")
        XCTAssertEqual(draft.trimmedDeliver, "legacy-target")
        XCTAssertEqual(draft.provider, "openai")
    }

    func testCronDeliverPickerFallsBackWithoutUsableOptions() {
        XCTAssertNil(CronDeliverPicker.options(serverOptions: nil, currentValue: "local"))
        XCTAssertNil(CronDeliverPicker.options(serverOptions: [], currentValue: "local"))
        XCTAssertNil(
            CronDeliverPicker.options(
                serverOptions: [CronDeliveryOption(value: "  ", label: "Blank"), CronDeliveryOption(value: nil, label: "No value")],
                currentValue: "local"
            )
        )
        XCTAssertNil(
            CronDeliverPicker.options(
                serverOptions: [CronDeliveryOption(value: "local", label: "Local")],
                currentValue: "   "
            ),
            "A blank draft value has nothing safe to select, so free text is kept."
        )
    }

    func testCronDeliverPickerKeepsUnknownValueAsCustomRow() throws {
        let serverOptions = [
            CronDeliveryOption(value: "local", label: "Local (save output only)"),
            CronDeliveryOption(value: "origin", label: "Origin (reply to creator)"),
            CronDeliveryOption(value: "origin", label: "Duplicate ignored"),
            CronDeliveryOption(value: "telegram", label: nil)
        ]

        let options = try XCTUnwrap(
            CronDeliverPicker.options(serverOptions: serverOptions, currentValue: "legacy-target")
        )

        XCTAssertEqual(options.map(\.value), ["local", "origin", "telegram", "legacy-target"])
        XCTAssertEqual(options.map(\.isCustom), [false, false, false, true])
        XCTAssertEqual(options.first?.label, "Local (save output only)")
        XCTAssertEqual(options[2].label, "telegram", "Missing labels fall back to the raw value.")

        let knownValue = try XCTUnwrap(
            CronDeliverPicker.options(serverOptions: serverOptions, currentValue: "origin")
        )
        XCTAssertEqual(knownValue.map(\.value), ["local", "origin", "telegram"])
        XCTAssertFalse(knownValue.contains(where: \.isCustom))
    }

    func testCronDeliverPickerPreservesInitialAndLiveCustomValues() throws {
        let serverOptions = [
            CronDeliveryOption(value: "local", label: "Local"),
            CronDeliveryOption(value: "telegram", label: "Telegram")
        ]

        // The editor's initial legacy value keeps its custom row even after
        // the user selects a server option (currentValue moved on).
        let afterSelection = try XCTUnwrap(
            CronDeliverPicker.options(
                serverOptions: serverOptions,
                currentValue: "telegram",
                initialValue: "legacy-target"
            )
        )
        XCTAssertEqual(afterSelection.map(\.value), ["local", "telegram", "legacy-target"])
        XCTAssertEqual(afterSelection.map(\.isCustom), [false, false, true])

        // A value typed into the free-text fallback while options were still
        // loading gets its own row alongside the initial value's row, so the
        // picker selection always has a matching tag.
        let typedWhileLoading = try XCTUnwrap(
            CronDeliverPicker.options(
                serverOptions: serverOptions,
                currentValue: "typed-target",
                initialValue: "local"
            )
        )
        XCTAssertEqual(typedWhileLoading.map(\.value), ["local", "telegram", "typed-target"])
        XCTAssertEqual(typedWhileLoading.map(\.isCustom), [false, false, true])

        // Identical initial and current custom values collapse to one row.
        let sameCustom = try XCTUnwrap(
            CronDeliverPicker.options(
                serverOptions: serverOptions,
                currentValue: "legacy-target",
                initialValue: "legacy-target"
            )
        )
        XCTAssertEqual(sameCustom.map(\.value), ["local", "telegram", "legacy-target"])
        XCTAssertEqual(sameCustom.filter(\.isCustom).count, 1)

        // A blank initial value adds no row.
        let blankInitial = try XCTUnwrap(
            CronDeliverPicker.options(
                serverOptions: serverOptions,
                currentValue: "local",
                initialValue: "   "
            )
        )
        XCTAssertEqual(blankInitial.map(\.value), ["local", "telegram"])
    }

    func testCronJobEditorDraftRequiresPromptAndSchedule() {
        XCTAssertEqual(
            CronJobEditorDraft(prompt: "", schedule: "0 7 * * *").validationMessage,
            "Prompt is required."
        )
        XCTAssertEqual(
            CronJobEditorDraft(prompt: "Run it", schedule: "   ").validationMessage,
            "Schedule is required."
        )
    }

    func testCronJobEditorDraftAppliesModelAndProviderTogether() {
        var draft = CronJobEditorDraft()

        draft.applyModelSelection(ModelCatalogOption(id: "gpt-5", displayName: "GPT-5", providerID: "openai"))
        XCTAssertEqual(draft.trimmedModel, "gpt-5")
        XCTAssertEqual(draft.trimmedProvider, "openai")

        // A stale provider paired with a new model is the mismatch the
        // combined picker exists to prevent.
        draft.applyModelSelection(ModelCatalogOption(id: "llama3", displayName: "llama3", providerID: nil))
        XCTAssertEqual(draft.model, "llama3")
        XCTAssertEqual(draft.provider, "")

        draft.applyModelSelection(ModelCatalogOption(id: "gpt-5", displayName: "GPT-5", providerID: "openai"))
        draft.applyModelSelection(nil)
        // Blank is what the server reads as "inherit"; the literal string is not.
        XCTAssertNil(draft.trimmedModel)
        XCTAssertNil(draft.trimmedProvider)
    }

    func testTaskEditorCustomModelEntryAllowsABareModelID() {
        // The task editor's only fallback when the catalog is missing or
        // failed; a bare id resolves through the profile or active provider.
        XCTAssertEqual(
            ComposerCustomModelOption.customOption(modelID: " gpt-5 ", providerID: "  ", requiresProviderID: false),
            ModelCatalogOption(id: "gpt-5", displayName: "gpt-5", providerID: nil)
        )
        XCTAssertEqual(
            ComposerCustomModelOption.customOption(modelID: "gpt-5", providerID: " OpenAI ", requiresProviderID: false),
            ModelCatalogOption(id: "gpt-5", displayName: "gpt-5", providerID: "openai")
        )
        XCTAssertNil(ComposerCustomModelOption.customOption(modelID: "  ", providerID: "openai", requiresProviderID: false))
        XCTAssertNil(
            ComposerCustomModelOption.customOption(modelID: "gpt-5", providerID: "", requiresProviderID: true),
            "The composer keeps requiring a provider id."
        )
    }

    func testCronJobEditorDraftModelSelectionKeepsUnknownModelVisible() {
        let catalog = [
            ModelCatalogGroup(
                id: "openai",
                name: "OpenAI",
                providerID: "openai",
                models: [ModelCatalogOption(id: "gpt-5", displayName: "GPT-5", providerID: "openai")]
            )
        ]

        XCTAssertEqual(
            CronJobEditorDraft(model: "gpt-5", provider: "openai").modelSelection(in: catalog),
            ModelCatalogOption(id: "gpt-5", displayName: "GPT-5", providerID: "openai")
        )
        XCTAssertEqual(
            CronJobEditorDraft(model: "retired-model", provider: "openai").modelSelection(in: catalog),
            ModelCatalogOption(id: "retired-model", displayName: "retired-model", providerID: "openai"),
            "A model the catalog no longer offers still names itself instead of reading as unconfigured."
        )
        XCTAssertNil(CronJobEditorDraft(model: "  ", provider: "openai").modelSelection(in: catalog))
    }

    func testCronJobEditorDraftSkillToggleRoundTripsThroughSkillsText() {
        var draft = CronJobEditorDraft(skillsText: "writing")

        draft.toggleSkill("research")
        XCTAssertEqual(draft.skillsText, "writing, research", "A new skill goes on the end.")
        XCTAssertEqual(draft.skills, ["writing", "research"])

        draft.toggleSkill("writing")
        XCTAssertEqual(draft.skills, ["research"])

        draft.applySkillSelection([])
        XCTAssertEqual(draft.skillsText, "")
        XCTAssertTrue(draft.skills.isEmpty)
    }

    func testCronProfilePickerFallsBackWithoutProfilesAndKeepsUnknownSelection() throws {
        XCTAssertNil(
            CronProfilePicker.options(profiles: nil, currentValue: "work"),
            "An unavailable profile list keeps free-text entry."
        )

        let profiles = [
            ProfileSummary(name: "default", path: nil, isDefault: true, isActive: true, gatewayRunning: nil, model: nil, provider: nil, hasEnv: nil, skillCount: nil),
            ProfileSummary(name: "work", path: nil, isDefault: nil, isActive: nil, gatewayRunning: nil, model: "gpt-5", provider: "openai", hasEnv: nil, skillCount: nil),
            ProfileSummary(name: nil, path: "/nameless", isDefault: nil, isActive: nil, gatewayRunning: nil, model: nil, provider: nil, hasEnv: nil, skillCount: nil)
        ]

        let blank = try XCTUnwrap(CronProfilePicker.options(profiles: profiles, currentValue: ""))
        XCTAssertEqual(blank.map(\.value), ["", "default", "work"], "Blank keeps the server's own choice selectable.")
        XCTAssertEqual(blank.first?.label, "Server Default")
        XCTAssertFalse(blank.contains(where: \.isCustom))

        let retired = try XCTUnwrap(
            CronProfilePicker.options(profiles: profiles, currentValue: "retired", initialValue: "retired")
        )
        XCTAssertEqual(retired.map(\.value), ["", "default", "work", "retired"])
        XCTAssertEqual(retired.last?.isCustom, true, "A saved profile the server no longer lists stays visible and removable.")

        let empty = try XCTUnwrap(CronProfilePicker.options(profiles: [], currentValue: ""))
        XCTAssertEqual(empty.map(\.value), [""])
    }

    func testCronJobSkillsPickerListsSelectedUnknownSkillsAndFilters() {
        let writing = SkillSummary(name: "writing", category: "docs", description: "Drafts prose", path: nil)
        let research = SkillSummary(name: "research", category: "web", description: "Reads sources", path: nil)

        let listed = CronJobSkillsSelection.skillsIncludingSelection([writing], selection: ["writing", "retired"])
        XCTAssertEqual(listed.compactMap(\.name), ["retired", "writing"], "A saved skill the server no longer offers stays removable.")

        XCTAssertEqual(CronJobSkillsSelection.filteredSkills([writing, research], query: "docs").compactMap(\.name), ["writing"])
        XCTAssertEqual(CronJobSkillsSelection.filteredSkills([writing, research], query: "sources").compactMap(\.name), ["research"])
        XCTAssertEqual(CronJobSkillsSelection.filteredSkills([writing, research], query: "  ").count, 2)
    }
}

final class CronManagementViewModelTests: APIClientTestCase {
    @MainActor
    func testTasksViewModelCreateInsertsReturnedJob() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/crons/create")

            return apiTestJSONResponse("""
            {
              "ok": true,
              "job": {
                "id": "job-created",
                "name": "Created",
                "prompt": "Run it",
                "schedule": {"kind": "cron", "expr": "0 7 * * *"},
                "enabled": true,
                "state": "scheduled"
              }
            }
            """, for: request)
        }
        let viewModel = TasksViewModel(server: try XCTUnwrap(URL(string: "https://example.test")), client: client)

        let didCreate = await viewModel.create(
            from: CronJobEditorDraft(
                name: "Created",
                prompt: "Run it",
                schedule: "0 7 * * *"
            )
        )

        XCTAssertTrue(didCreate)
        XCTAssertEqual(viewModel.jobs.map(\.jobId), ["job-created"])
        XCTAssertNil(viewModel.actionErrorMessage)
    }

    @MainActor
    func testTasksViewModelLoadPopulatesDeliveryOptions() async throws {
        let client = makeClient { request in
            switch request.url?.path {
            case "/api/crons":
                return apiTestJSONResponse(#"{"jobs": []}"#, for: request)
            case "/api/crons/status":
                return apiTestJSONResponse(#"{"running": {}}"#, for: request)
            case "/api/crons/delivery-options":
                return apiTestJSONResponse(
                    #"{"platforms": [{"value": "local", "label": "Local (save output only)"}]}"#,
                    for: request
                )
            default:
                XCTFail("Unexpected request: \(request.url?.path ?? "nil")")
                return apiTestJSONResponse("{}", for: request)
            }
        }
        let viewModel = TasksViewModel(server: try XCTUnwrap(URL(string: "https://example.test")), client: client)

        await viewModel.load()

        XCTAssertEqual(viewModel.deliveryOptions?.count, 1)
        XCTAssertEqual(viewModel.deliveryOptions?.first?.value, "local")
        XCTAssertNil(viewModel.errorMessage)
    }

    @MainActor
    func testTasksViewModelLoadToleratesDeliveryOptionsFailure() async throws {
        let client = makeClient { request in
            switch request.url?.path {
            case "/api/crons":
                return apiTestJSONResponse(#"{"jobs": [{"id": "job123", "name": "Digest"}]}"#, for: request)
            case "/api/crons/status":
                return apiTestJSONResponse(#"{"running": {}}"#, for: request)
            case "/api/crons/delivery-options":
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: 404,
                    httpVersion: nil,
                    headerFields: ["Content-Type": "application/json"]
                )!
                return (response, Data(#"{"error": "not found"}"#.utf8))
            default:
                XCTFail("Unexpected request: \(request.url?.path ?? "nil")")
                return apiTestJSONResponse("{}", for: request)
            }
        }
        let viewModel = TasksViewModel(server: try XCTUnwrap(URL(string: "https://example.test")), client: client)

        await viewModel.load()

        XCTAssertNil(viewModel.deliveryOptions, "Endpoint failure must fall back to free-text deliver entry.")
        XCTAssertEqual(viewModel.jobs.map(\.jobId), ["job123"], "Jobs must still load when delivery options fail.")
        XCTAssertNil(viewModel.errorMessage)
    }

    @MainActor
    func testTaskDetailViewModelPauseUpdatesJobAndPublishesMutation() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/crons/pause")

            return apiTestJSONResponse("""
            {
              "ok": true,
              "job": {
                "id": "job123",
                "name": "Digest",
                "prompt": "Run it",
                "schedule": {"kind": "cron", "expr": "0 7 * * *"},
                "enabled": true,
                "state": "paused"
              }
            }
            """, for: request)
        }
        let viewModel = TaskDetailViewModel(
            job: try decodeCronJob("""
            {
              "id": "job123",
              "name": "Digest",
              "prompt": "Run it",
              "schedule": {"kind": "cron", "expr": "0 7 * * *"},
              "enabled": true,
              "state": "scheduled"
            }
            """),
            runningElapsed: 12,
            server: try XCTUnwrap(URL(string: "https://example.test")),
            client: client
        )

        let didPause = await viewModel.pause()

        XCTAssertTrue(didPause)
        XCTAssertEqual(viewModel.job.status, .paused)
        XCTAssertNil(viewModel.runningElapsed)
        guard case .upsert(let updatedJob) = viewModel.lastMutation else {
            XCTFail("Expected upsert mutation.")
            return
        }
        XCTAssertEqual(updatedJob.jobId, "job123")
    }

    @MainActor
    func testTaskDetailViewModelDeletePublishesDeleteMutation() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/crons/delete")

            return apiTestJSONResponse("""
            {
              "ok": true,
              "job": {"id": "job123"}
            }
            """, for: request)
        }
        let viewModel = TaskDetailViewModel(
            job: try decodeCronJob(#"{"id": "job123", "name": "Digest"}"#),
            runningElapsed: nil,
            server: try XCTUnwrap(URL(string: "https://example.test")),
            client: client
        )

        let didDelete = await viewModel.delete()

        XCTAssertTrue(didDelete)
        XCTAssertEqual(viewModel.lastMutation, .delete(jobID: "job123"))
    }

    @MainActor
    func testCronJobEditorCatalogsLoadModelsProfilesAndEnabledSkills() async throws {
        let client = makeClient { request in
            switch request.url?.path {
            case "/api/models":
                return apiTestJSONResponse("""
                {
                  "groups": [
                    {"name": "OpenAI", "provider_id": "openai", "models": [{"id": "gpt-5", "name": "GPT-5"}]}
                  ]
                }
                """, for: request)
            case "/api/profiles":
                return apiTestJSONResponse(
                    #"{"active": "default", "profiles": [{"name": "work", "model": "gpt-5", "provider": "openai"}]}"#,
                    for: request
                )
            case "/api/skills":
                return apiTestJSONResponse(
                    #"{"skills": [{"name": "writing", "category": "docs"}, {"name": "retired", "disabled": true}]}"#,
                    for: request
                )
            default:
                XCTFail("Unexpected request: \(request.url?.path ?? "nil")")
                return apiTestJSONResponse("{}", for: request)
            }
        }

        let catalogs = CronJobEditorCatalogs(client: client)
        await catalogs.load()

        XCTAssertEqual(catalogs.modelGroups.flatMap(\.models).map(\.id), ["gpt-5"])
        XCTAssertEqual(catalogs.profiles?.map(\.normalizedName), ["work"])
        XCTAssertEqual(catalogs.skills.compactMap(\.name), ["writing"], "A disabled skill would be ignored by the run.")
        XCTAssertNil(catalogs.errorMessage)
        XCTAssertFalse(catalogs.isLoading)
    }

    @MainActor
    func testCronJobEditorCatalogsTolerateUnavailableCatalogs() async throws {
        var profilesFail = true
        let client = makeClient { request in
            switch request.url?.path {
            case "/api/models":
                throw URLError(.timedOut)
            case "/api/profiles":
                if profilesFail { throw URLError(.notConnectedToInternet) }
                return apiTestJSONResponse(#"{"profiles": [{"name": "work"}]}"#, for: request)
            case "/api/skills":
                throw URLError(.timedOut)
            default:
                XCTFail("Unexpected request: \(request.url?.path ?? "nil")")
                return apiTestJSONResponse("{}", for: request)
            }
        }

        let catalogs = CronJobEditorCatalogs(client: client)
        await catalogs.load()

        XCTAssertNotNil(catalogs.modelsErrorMessage)
        XCTAssertNotNil(catalogs.profilesErrorMessage)
        XCTAssertNotNil(catalogs.skillsErrorMessage)
        XCTAssertEqual(catalogs.errorMessage, catalogs.modelsErrorMessage)
        XCTAssertTrue(catalogs.modelGroups.isEmpty)
        XCTAssertNil(catalogs.profiles, "A failed profile list keeps the free-text fallback.")
        XCTAssertTrue(catalogs.skills.isEmpty)

        // The saved draft survives untouched, and custom values still apply.
        var draft = CronJobEditorDraft(prompt: "Report", schedule: "0 9 * * *", skillsText: "writing", model: "gpt-5", provider: "openai")
        XCTAssertNil(draft.validationMessage)
        XCTAssertNil(CronProfilePicker.options(profiles: catalogs.profiles, currentValue: draft.profile))
        XCTAssertEqual(
            CronJobSkillsSelection.skillsIncludingSelection(catalogs.skills, selection: draft.skills).compactMap(\.name),
            ["writing"]
        )
        draft.applyModelSelection(ModelCatalogOption(id: "gpt-5-mini", displayName: "gpt-5-mini", providerID: "openai"))
        draft.toggleSkill("research")
        XCTAssertEqual(draft.trimmedModel, "gpt-5-mini")
        XCTAssertEqual(draft.skills, ["writing", "research"])

        profilesFail = false
        await catalogs.load()
        XCTAssertEqual(catalogs.profiles?.map(\.normalizedName), ["work"], "Retry recovers the catalogs that now load.")
        XCTAssertNil(catalogs.profilesErrorMessage)
        XCTAssertNotNil(catalogs.skillsErrorMessage, "The catalogs that still fail keep reporting.")
    }

    @MainActor
    func testCronJobEditorCatalogsIgnoreCancellation() async throws {
        let client = makeClient { _ in throw URLError(.cancelled) }

        let catalogs = CronJobEditorCatalogs(client: client)
        await catalogs.load()

        XCTAssertNil(catalogs.errorMessage, "A sheet dismissed mid-load is not a failure the user should see.")
    }

    @MainActor
    func testTasksViewModelCreateSendsPickerSelections() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/crons/create")
            let body = try XCTUnwrap(apiTestBodyData(from: request))
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            XCTAssertEqual(json["model"] as? String, "gpt-5")
            XCTAssertEqual(json["provider"] as? String, "openai")
            XCTAssertEqual(json["profile"] as? String, "work")
            XCTAssertEqual(json["skills"] as? [String], ["writing", "research"])

            return apiTestJSONResponse(#"{"ok": true, "job": {"id": "job-created", "prompt": "Run it"}}"#, for: request)
        }
        let viewModel = TasksViewModel(server: try XCTUnwrap(URL(string: "https://example.test")), client: client)

        var draft = CronJobEditorDraft(prompt: "Run it", schedule: "0 7 * * *")
        draft.applyModelSelection(ModelCatalogOption(id: "gpt-5", displayName: "GPT-5", providerID: "openai"))
        draft.profile = "work"
        draft.toggleSkill("writing")
        draft.toggleSkill("research")
        // Choosing a profile never prefills the model: the server fills it in
        // from the profile only while the model is blank.
        XCTAssertEqual(draft.trimmedModel, "gpt-5")

        let didCreate = await viewModel.create(from: draft)

        XCTAssertTrue(didCreate)
        XCTAssertEqual(viewModel.jobs.map(\.jobId), ["job-created"])
    }

    @MainActor
    func testTaskDetailViewModelUpdateSendsClearedModelAndProvider() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/crons/update")
            let body = try XCTUnwrap(apiTestBodyData(from: request))
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            XCTAssertEqual(json["job_id"] as? String, "job123")
            XCTAssertEqual(json["model"] as? String, "", "Server Default clears the override rather than keeping the saved model.")
            XCTAssertEqual(json["provider"] as? String, "")
            XCTAssertEqual(json["profile"] as? String, "")
            XCTAssertEqual(json["skills"] as? [String], ["writing"])

            return apiTestJSONResponse(#"{"ok": true, "job": {"id": "job123", "model": "", "provider": ""}}"#, for: request)
        }
        let job = try decodeCronJob(
            #"{"id": "job123", "prompt": "Run it", "schedule": "0 7 * * *", "model": "gpt-5", "provider": "openai", "profile": "retired", "skills": ["writing", "retired-skill"]}"#
        )
        let viewModel = TaskDetailViewModel(
            job: job,
            runningElapsed: nil,
            server: try XCTUnwrap(URL(string: "https://example.test")),
            client: client
        )

        var draft = CronJobEditorDraft(job: job)
        XCTAssertEqual(draft.skills, ["writing", "retired-skill"])
        draft.applyModelSelection(nil)
        draft.profile = CronProfilePicker.serverDefaultValue
        draft.toggleSkill("retired-skill")

        let didUpdate = await viewModel.update(from: draft)

        XCTAssertTrue(didUpdate)
        XCTAssertEqual(viewModel.job.jobId, "job123")
    }

    @MainActor
    func testTaskDetailViewModelPagesHistoryByRequestedLimit() async throws {
        let requestedOffsets = LockedValues<String>()
        let client = makeClient { request in
            switch request.url?.path {
            case "/api/crons/output":
                return apiTestJSONResponse(#"{"outputs": [{"filename": "latest.md", "content": "recent"}]}"#, for: request)
            case "/api/crons/delivery-options":
                return apiTestJSONResponse(#"{"platforms": []}"#, for: request)
            case "/api/crons/history":
                let query = try Self.queryItems(from: request)
                XCTAssertEqual(query["job_id"], "job123")
                XCTAssertEqual(query["limit"], "20")
                let offset = try XCTUnwrap(query["offset"])
                requestedOffsets.append(offset)
                // Page 1 lost two unreadable files after slicing; the cursor must still advance by 20.
                let pageSize = ["0": 18, "20": 20, "40": 5][offset] ?? 0
                return apiTestJSONResponse(Self.historyJSON(offset: Int(offset) ?? 0, count: pageSize, total: 45), for: request)
            default:
                XCTFail("Unexpected request: \(request.url?.path ?? "nil")")
                return apiTestJSONResponse("{}", for: request)
            }
        }
        let viewModel = TaskDetailViewModel(
            job: try decodeCronJob(#"{"id": "job123", "name": "Digest"}"#),
            runningElapsed: nil,
            server: try XCTUnwrap(URL(string: "https://example.test")),
            client: client
        )

        await viewModel.load()

        XCTAssertEqual(viewModel.outputs.count, 1)
        XCTAssertEqual(viewModel.runs.count, 18)
        XCTAssertEqual(viewModel.runs.first?.filename, "run-0.md", "History must keep the server's newest-first order.")
        XCTAssertEqual(viewModel.runsTotal, 45)
        XCTAssertTrue(viewModel.hasMoreRuns)
        XCTAssertTrue(viewModel.isHistorySupported)

        await viewModel.loadRunHistory()
        XCTAssertEqual(viewModel.runs.count, 38)
        XCTAssertTrue(viewModel.hasMoreRuns)

        await viewModel.loadRunHistory()
        XCTAssertEqual(viewModel.runs.count, 43)
        XCTAssertFalse(viewModel.hasMoreRuns)

        await viewModel.loadRunHistory()
        XCTAssertEqual(requestedOffsets.values, ["0", "20", "40"], "An exhausted cursor must not request another page.")
    }

    @MainActor
    func testTaskDetailViewModelHistoryFailureKeepsOutputAndRetries() async throws {
        let historyRequests = LockedCounter()
        let client = makeClient { request in
            switch request.url?.path {
            case "/api/crons/output":
                return apiTestJSONResponse(#"{"outputs": [{"filename": "latest.md", "content": "recent"}]}"#, for: request)
            case "/api/crons/delivery-options":
                return apiTestJSONResponse(#"{"platforms": []}"#, for: request)
            case "/api/crons/history":
                if historyRequests.increment() == 1 {
                    return apiTestJSONResponse(#"{"error": "boom"}"#, statusCode: 500, for: request)
                }
                return apiTestJSONResponse(Self.historyJSON(offset: 0, count: 2, total: 2), for: request)
            default:
                XCTFail("Unexpected request: \(request.url?.path ?? "nil")")
                return apiTestJSONResponse("{}", for: request)
            }
        }
        let viewModel = TaskDetailViewModel(
            job: try decodeCronJob(#"{"id": "job123", "name": "Digest"}"#),
            runningElapsed: nil,
            server: try XCTUnwrap(URL(string: "https://example.test")),
            client: client
        )

        await viewModel.load()

        XCTAssertEqual(viewModel.outputs.count, 1, "Recent output must survive a history failure.")
        XCTAssertNil(viewModel.errorMessage)
        XCTAssertNotNil(viewModel.runsErrorMessage)
        XCTAssertTrue(viewModel.isHistorySupported)
        XCTAssertTrue(viewModel.runs.isEmpty)

        await viewModel.loadRunHistory(reset: true)

        XCTAssertNil(viewModel.runsErrorMessage)
        XCTAssertEqual(viewModel.runs.count, 2)
        XCTAssertFalse(viewModel.hasMoreRuns)
    }

    @MainActor
    func testTaskDetailViewModelRetryAfterFailedRefreshReloadsExhaustedHistory() async throws {
        let historyRequests = LockedCounter()
        let requestedOffsets = LockedValues<String>()
        let client = makeClient { request in
            switch request.url?.path {
            case "/api/crons/output":
                return apiTestJSONResponse(#"{"outputs": []}"#, for: request)
            case "/api/crons/delivery-options":
                return apiTestJSONResponse(#"{"platforms": []}"#, for: request)
            case "/api/crons/history":
                requestedOffsets.append(try Self.queryItems(from: request)["offset"] ?? "")
                switch historyRequests.increment() {
                case 2:
                    return apiTestJSONResponse(#"{"error": "boom"}"#, statusCode: 500, for: request)
                default:
                    return apiTestJSONResponse(Self.historyJSON(offset: 0, count: 2, total: 2), for: request)
                }
            default:
                XCTFail("Unexpected request: \(request.url?.path ?? "nil")")
                return apiTestJSONResponse("{}", for: request)
            }
        }
        let viewModel = TaskDetailViewModel(
            job: try decodeCronJob(#"{"id": "job123", "name": "Digest"}"#),
            runningElapsed: nil,
            server: try XCTUnwrap(URL(string: "https://example.test")),
            client: client
        )

        await viewModel.load()
        XCTAssertEqual(viewModel.runs.count, 2)
        XCTAssertFalse(viewModel.hasMoreRuns)

        await viewModel.load()
        XCTAssertNotNil(viewModel.runsErrorMessage)
        XCTAssertEqual(viewModel.runs.count, 2, "A failed refresh keeps the rows already on screen.")

        await viewModel.retryRunHistory()
        XCTAssertNil(viewModel.runsErrorMessage)
        XCTAssertEqual(viewModel.runs.count, 2)
        XCTAssertEqual(requestedOffsets.values, ["0", "0", "0"], "Retrying a failed refresh must request the first page again.")
    }

    @MainActor
    func testTaskDetailViewModelUnsupportedHistoryDegradesToRecentOutput() async throws {
        let client = makeClient { request in
            switch request.url?.path {
            case "/api/crons/output":
                return apiTestJSONResponse(#"{"outputs": [{"filename": "latest.md", "content": "recent"}]}"#, for: request)
            case "/api/crons/delivery-options":
                return apiTestJSONResponse(#"{"platforms": []}"#, for: request)
            case "/api/crons/history":
                return apiTestJSONResponse(#"{"error": "not found"}"#, statusCode: 404, for: request)
            default:
                XCTFail("Unexpected request: \(request.url?.path ?? "nil")")
                return apiTestJSONResponse("{}", for: request)
            }
        }
        let viewModel = TaskDetailViewModel(
            job: try decodeCronJob(#"{"id": "job123", "name": "Digest"}"#),
            runningElapsed: nil,
            server: try XCTUnwrap(URL(string: "https://example.test")),
            client: client
        )

        await viewModel.load()

        XCTAssertEqual(viewModel.outputs.count, 1)
        XCTAssertFalse(viewModel.isHistorySupported)
        XCTAssertNil(viewModel.runsErrorMessage)
        XCTAssertNil(viewModel.errorMessage)
        XCTAssertNil(viewModel.lastError)
    }

    @MainActor
    func testTaskDetailViewModelRefreshFencesStaleHistoryPageAndRunOutput() async throws {
        let host = "tal166-fence.test"
        let historyRequests = LockedValues<DeferredMockURLProtocol>()
        let runRequests = LockedValues<DeferredMockURLProtocol>()
        let historyStarted = [expectation(description: "history 1"), expectation(description: "history 2")]
        let runStarted = [expectation(description: "run 1"), expectation(description: "run 2")]
        DeferredMockURLProtocol.setOnRequest({ request in
            switch request.request.url?.path {
            case "/api/crons/output":
                request.complete(withJSON: #"{"outputs": []}"#)
            case "/api/crons/delivery-options":
                request.complete(withJSON: #"{"platforms": []}"#)
            case "/api/crons/history":
                historyStarted[historyRequests.append(request) - 1].fulfill()
            case "/api/crons/run":
                XCTAssertEqual(request.request.httpMethod, "GET")
                runStarted[runRequests.append(request) - 1].fulfill()
            default:
                XCTFail("Unexpected request: \(request.request.url?.path ?? "nil")")
            }
        }, forHost: host)
        defer { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DeferredMockURLProtocol.self]
        let server = try XCTUnwrap(URL(string: "https://\(host)"))
        let viewModel = TaskDetailViewModel(
            job: try decodeCronJob(#"{"id": "job123", "name": "Digest"}"#),
            runningElapsed: nil,
            server: server,
            client: APIClient(baseURL: server, session: URLSession(configuration: configuration))
        )

        let staleLoad = Task { @MainActor in await viewModel.load() }
        await fulfillment(of: [historyStarted[0]], timeout: 5)
        let freshLoad = Task { @MainActor in await viewModel.loadRunHistory(reset: true) }
        await fulfillment(of: [historyStarted[1]], timeout: 5)

        historyRequests.values[1].complete(withJSON: Self.historyJSON(offset: 0, count: 1, total: 1, prefix: "fresh"))
        await freshLoad.value
        XCTAssertEqual(viewModel.runs.map(\.filename), ["fresh-0.md"])

        historyRequests.values[0].complete(withJSON: Self.historyJSON(offset: 0, count: 3, total: 3, prefix: "stale"))
        await staleLoad.value
        XCTAssertEqual(viewModel.runs.map(\.filename), ["fresh-0.md"], "A page from before the refresh must be dropped.")
        XCTAssertEqual(viewModel.runsTotal, 1)
        XCTAssertFalse(viewModel.isLoadingRuns)

        let staleRun = try XCTUnwrap(viewModel.runs.first)
        let freshRun = try decodeRun(#"{"filename": "fresh-1.md"}"#)
        let staleDetail = Task { @MainActor in await viewModel.loadRunDetail(staleRun) }
        await fulfillment(of: [runStarted[0]], timeout: 5)
        let freshDetail = Task { @MainActor in await viewModel.loadRunDetail(freshRun) }
        await fulfillment(of: [runStarted[1]], timeout: 5)

        runRequests.values[1].complete(withJSON: #"{"filename": "fresh-1.md", "content": "output of fresh-1.md"}"#)
        await freshDetail.value
        XCTAssertEqual(viewModel.selectedRunDetail?.content, "output of fresh-1.md")

        runRequests.values[0].complete(withJSON: #"{"filename": "fresh-0.md", "content": "output of fresh-0.md"}"#)
        await staleDetail.value
        XCTAssertEqual(viewModel.selectedRun?.filename, "fresh-1.md")
        XCTAssertEqual(viewModel.selectedRunDetail?.content, "output of fresh-1.md", "An earlier run's output must not replace the selected run.")
        XCTAssertFalse(viewModel.isLoadingRunDetail)

        viewModel.dismissRun()
        XCTAssertNil(viewModel.selectedRun)
        XCTAssertNil(viewModel.selectedRunDetail)
    }

    @MainActor
    func testTaskDetailViewModelRunDetailFailureKeepsSelectionForRetry() async throws {
        let runRequests = LockedCounter()
        let client = makeClient { request in
            switch request.url?.path {
            case "/api/crons/run":
                XCTAssertEqual(request.httpMethod, "GET")
                XCTAssertNil(request.httpBody)
                if runRequests.increment() == 1 {
                    return apiTestJSONResponse(#"{"error": "run not found"}"#, statusCode: 404, for: request)
                }
                return apiTestJSONResponse(#"{"filename": "run-0.md", "content": ""}"#, for: request)
            default:
                XCTFail("Unexpected request: \(request.url?.path ?? "nil")")
                return apiTestJSONResponse("{}", for: request)
            }
        }
        let viewModel = TaskDetailViewModel(
            job: try decodeCronJob(#"{"id": "job123", "name": "Digest"}"#),
            runningElapsed: nil,
            server: try XCTUnwrap(URL(string: "https://example.test")),
            client: client
        )
        let run = try decodeRun(#"{"filename": "run-0.md", "size": 0}"#)

        await viewModel.loadRunDetail(run)
        XCTAssertEqual(viewModel.selectedRun?.filename, "run-0.md")
        XCTAssertNil(viewModel.selectedRunDetail)
        XCTAssertNotNil(viewModel.runDetailErrorMessage)

        await viewModel.loadRunDetail(run)
        XCTAssertNil(viewModel.runDetailErrorMessage)
        XCTAssertEqual(viewModel.selectedRunDetail?.content, "")
    }

    // TAL-435: a live refresh clears a finished run's "Running" badge, picks up new output and the
    // job's latest state, and leaves a run the user opened selected.
    @MainActor
    func testTaskDetailRefreshTracksAFinishedRunWithoutClosingTheOpenRun() async throws {
        let client = makeClient { request in
            switch request.url?.path {
            case "/api/crons/run":
                if request.httpMethod == "POST" {
                    return apiTestJSONResponse(#"{"ok": true, "job": {"id": "job123", "name": "Digest"}}"#, for: request)
                }
                return apiTestJSONResponse(#"{"job_id": "job123", "filename": "run-0.md", "content": "opened"}"#, for: request)
            case "/api/crons/status":
                XCTAssertEqual(try Self.queryItems(from: request)["job_id"], "job123")
                return apiTestJSONResponse(#"{"job_id": "job123", "running": false, "elapsed": null}"#, for: request)
            case "/api/crons":
                return apiTestJSONResponse(#"{"jobs": [{"id": "job123", "name": "Digest", "last_status": "ok"}]}"#, for: request)
            case "/api/crons/output":
                return apiTestJSONResponse(#"{"outputs": [{"filename": "new.md", "content": "fresh"}]}"#, for: request)
            case "/api/crons/history":
                return apiTestJSONResponse(Self.historyJSON(offset: 0, count: 2, total: 2), for: request)
            case "/api/crons/delivery-options":
                return apiTestJSONResponse(#"{"platforms": []}"#, for: request)
            default:
                XCTFail("Unexpected request: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }
        let viewModel = TaskDetailViewModel(
            job: try decodeCronJob(#"{"id": "job123", "name": "Digest"}"#),
            runningElapsed: nil,
            server: try XCTUnwrap(URL(string: "https://example.test")),
            client: client
        )
        let didRun = await viewModel.runNow()
        XCTAssertTrue(didRun)
        XCTAssertEqual(viewModel.runningElapsed, 0)
        await viewModel.loadRunDetail(try decodeRun(#"{"filename": "run-0.md", "size": 10}"#))

        await viewModel.refresh()

        XCTAssertNil(viewModel.runningElapsed, "The run finished, so the badge clears")
        XCTAssertEqual(viewModel.outputs.map(\.filename), ["new.md"])
        XCTAssertEqual(viewModel.job.lastStatus, "ok")
        XCTAssertEqual(viewModel.runs.count, 2)
        XCTAssertEqual(viewModel.selectedRun?.filename, "run-0.md", "A refresh never closes the run the user opened")
    }

    private static func historyJSON(offset: Int, count: Int, total: Int, prefix: String = "run") -> String {
        let runs = (0..<count).map { index in
            #"{"filename": "\#(prefix)-\#(offset + index).md", "size": 10, "modified": \#(2_000_000_000 - offset - index)}"#
        }
        return #"{"job_id": "job123", "runs": [\#(runs.joined(separator: ","))], "total": \#(total), "offset": \#(offset)}"#
    }

    private static func queryItems(from request: URLRequest) throws -> [String: String] {
        let components = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)
        return Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
    }

    private func decodeRun(_ json: String) throws -> CronRunSummary {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(CronRunSummary.self, from: Data(json.utf8))
    }

    private func decodeCronJob(_ json: String) throws -> CronJob {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(CronJob.self, from: Data(json.utf8))
    }
}

private final class LockedValues<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [Value] = []

    /// Returns the new count so callers can index the value they just appended.
    @discardableResult
    func append(_ value: Value) -> Int {
        lock.withLock {
            storage.append(value)
            return storage.count
        }
    }

    var values: [Value] {
        lock.withLock { storage }
    }
}
