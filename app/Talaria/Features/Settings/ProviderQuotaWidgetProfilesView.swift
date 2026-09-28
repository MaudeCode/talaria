import SwiftUI
import TalariaKit

struct ProviderQuotaWidgetProfilesView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var profiles = ProviderQuotaWidgetProfileStore.profiles()
    @State private var selectedDefaultProfileID = ProviderQuotaWidgetProfileStore.selectedDefaultProfileID()
    @State private var isNamingProfile = false
    @State private var newProfileName = ""

    var body: some View {
        Form {
            Section {
                HStack {
                    Label("App Default", systemImage: "slider.horizontal.3")
                    Spacer()
                    if selectedDefaultProfileID == nil {
                        defaultCheckmark
                    } else {
                        Button {
                            ProviderQuotaWidgetProfileStore.setDefault(id: nil)
                            reload()
                        } label: {
                            Image(systemName: "circle").frame(width: 44, height: 44)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Set App Default as default widget profile")
                    }
                }

                ForEach(profiles) { profile in
                    HStack {
                        Text(profile.name).lineLimit(1)
                        Spacer(minLength: 8)
                        if selectedDefaultProfileID == profile.id { defaultCheckmark }
                        profileMenu(profile)
                    }
                }

                Button {
                    newProfileName = ""
                    isNamingProfile = true
                } label: {
                    Label("Save Current Settings", systemImage: "plus")
                }
            } footer: {
                Text("Profiles are named snapshots of the current Widget Appearance settings. Load one to edit it, then update the snapshot.")
            }
        }
        .navigationTitle("Widget Profiles")
        .alert("Save Widget Profile", isPresented: $isNamingProfile) {
            TextField("Profile Name", text: $newProfileName)
            Button("Cancel", role: .cancel) {}
            Button("Save") {
                _ = ProviderQuotaWidgetProfileStore.saveCurrent(name: newProfileName)
                reload()
            }
        } message: {
            Text("Save the current appearance and behavior settings as a reusable widget profile.")
        }
    }

    private var defaultCheckmark: some View {
        Image(systemName: "checkmark.circle.fill")
            .foregroundStyle(.green)
            .accessibilityLabel("Default widget profile")
    }

    private func profileMenu(_ profile: ProviderQuotaWidgetSavedProfile) -> some View {
        Menu {
            if selectedDefaultProfileID != profile.id {
                Button("Set as Default", systemImage: "checkmark.circle") {
                    ProviderQuotaWidgetProfileStore.setDefault(id: profile.id)
                    reload()
                }
            }
            Button("Load into Editor", systemImage: "square.and.arrow.down") {
                ProviderQuotaWidgetProfileStore.apply(profile)
                ProviderQuotaWidgetSnapshotStore.reloadTimelines()
                dismiss()
            }
            Button("Update from Current", systemImage: "arrow.triangle.2.circlepath") {
                _ = ProviderQuotaWidgetProfileStore.saveCurrent(name: profile.name, id: profile.id)
                reload()
            }
            Button("Delete", systemImage: "trash", role: .destructive) {
                ProviderQuotaWidgetProfileStore.delete(id: profile.id)
                reload()
            }
        } label: {
            Image(systemName: "ellipsis.circle").frame(width: 44, height: 44)
        }
        .accessibilityLabel("Manage \(profile.name) profile")
    }

    private func reload() {
        profiles = ProviderQuotaWidgetProfileStore.profiles()
        selectedDefaultProfileID = ProviderQuotaWidgetProfileStore.selectedDefaultProfileID()
        ProviderQuotaWidgetSnapshotStore.reloadTimelines()
    }
}
