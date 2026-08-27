import SwiftUI

/// One selectable plant type (built-in or user-defined custom).
struct SpeciesOption: Decodable, Identifiable, Hashable {
    let key: String
    let label: String
    let low: Int?
    let high: Int?
    let builtin: Bool
    var id: String { key }
}

/// Loads the plant-type catalog from the backend (built-in + the user's custom
/// types) so the picker stays in sync with no app update, and creates new
/// custom types. Falls back to a built-in list if the endpoint is unreachable.
@MainActor
final class SpeciesCatalog: ObservableObject {
    static let shared = SpeciesCatalog()
    @Published private(set) var options: [SpeciesOption] = SpeciesCatalog.fallback
    @Published private(set) var loaded = false

    private struct Resp: Decodable { let species: [SpeciesOption] }

    func loadIfNeeded() async { if !loaded { await reload() } }

    func reload() async {
        guard let data = try? await Auth.shared.authed("functions/v1/species-catalog"),
              let r = try? JSONDecoder().decode(Resp.self, from: data), !r.species.isEmpty else { return }
        options = r.species
        loaded = true
    }

    func label(for key: String) -> String { options.first(where: { $0.key == key })?.label ?? key }

    /// Create a custom plant type and return its key. Refreshes the catalog.
    func addCustom(label: String, low: Int, high: Int, why: String?) async throws -> String {
        guard let uid = await Auth.shared.userId else { throw Auth.AuthError.message("Not signed in") }
        let slug = label.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }.joined(separator: "_")
        let key = "custom_" + (slug.isEmpty ? "type" : slug)
        var body: [String: Any] = ["user_id": uid, "key": key, "label": label, "ideal_low": low, "ideal_high": high, "size": "medium"]
        if let why, !why.isEmpty { body["why"] = why }
        _ = try await Auth.shared.authed("rest/v1/species_profiles", method: "POST", json: body,
                                         prefer: "resolution=merge-duplicates,return=minimal")
        await reload()
        return key
    }

    /// Used only if the catalog endpoint can't be reached during onboarding.
    static let fallback: [SpeciesOption] = [
        .init(key: "citrus", label: "Citrus (orange, lime…)", low: 35, high: 55, builtin: true),
        .init(key: "lemon", label: "Lemon", low: 40, high: 60, builtin: true),
        .init(key: "avocado", label: "Avocado", low: 40, high: 60, builtin: true),
        .init(key: "camellia", label: "Camellia", low: 35, high: 50, builtin: true),
        .init(key: "hydrangea", label: "Hydrangea", low: 40, high: 60, builtin: true),
        .init(key: "rosemary", label: "Rosemary", low: 18, high: 35, builtin: true),
        .init(key: "lavender", label: "Lavender", low: 20, high: 38, builtin: true),
        .init(key: "westringia", label: "Westringia (coast rosemary)", low: 20, high: 38, builtin: true),
        .init(key: "bay_laurel", label: "Bay Laurel", low: 22, high: 40, builtin: true),
        .init(key: "star_jasmine", label: "Star Jasmine", low: 30, high: 50, builtin: true),
        .init(key: "boxwood", label: "Boxwood", low: 28, high: 50, builtin: true),
        .init(key: "convolvulus", label: "Convolvulus (silverbush)", low: 20, high: 40, builtin: true),
        .init(key: "carrotwood", label: "Carrotwood", low: 25, high: 45, builtin: true),
        .init(key: "unknown", label: "Other / not sure (set later)", low: nil, high: nil, builtin: true),
    ]
}

/// A reusable plant-type picker: all catalog types + an "Add a plant type…" action.
struct SpeciesPicker: View {
    @Binding var selection: String
    @ObservedObject private var catalog = SpeciesCatalog.shared
    @State private var showAdd = false

    var body: some View {
        Menu {
            Picker("Type", selection: $selection) {
                ForEach(catalog.options) { opt in Text(opt.label).tag(opt.key) }
            }
            Divider()
            Button { showAdd = true } label: { Label("Add a plant type…", systemImage: "plus.circle") }
        } label: {
            HStack {
                Text("Type").foregroundStyle(.secondary)
                Spacer()
                Text(catalog.label(for: selection)).foregroundStyle(.primary).lineLimit(1)
                Image(systemName: "chevron.up.chevron.down").font(.caption2).foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
        }
        .task { await catalog.loadIfNeeded() }
        .sheet(isPresented: $showAdd) { AddSpeciesView { newKey in selection = newKey } }
    }
}

/// Form to create a custom plant type (name + ideal moisture band + optional note).
private struct AddSpeciesView: View {
    let onAdded: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var catalog = SpeciesCatalog.shared
    @State private var label = ""
    @State private var low: Double = 30
    @State private var high: Double = 50
    @State private var why = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Plant type name") {
                    TextField("e.g. Tomato", text: $label).autocorrectionDisabled()
                }
                Section {
                    HStack { Text("Low").frame(width: 42, alignment: .leading).foregroundStyle(.secondary)
                        Slider(value: $low, in: 5...80, step: 1)
                        Text("\(Int(low))%").monospacedDigit().frame(width: 44, alignment: .trailing) }
                    HStack { Text("High").frame(width: 42, alignment: .leading).foregroundStyle(.secondary)
                        Slider(value: $high, in: 20...95, step: 1)
                        Text("\(Int(high))%").monospacedDigit().frame(width: 44, alignment: .trailing) }
                } header: {
                    Text("Ideal soil moisture")
                } footer: {
                    Text("The app advises watering when moisture drops below the low end, and to hold off above the high end.")
                }
                Section("Care note (optional)") {
                    TextField("How to water / why this range", text: $why, axis: .vertical).lineLimit(2...4)
                }
                if let error { Section { Text(error).foregroundStyle(DS.bad).font(.footnote) } }
            }
            .navigationTitle("New plant type")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Cancel") { dismiss() }.disabled(busy) }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Save") { save() }
                        .disabled(busy || label.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }

    private func save() {
        busy = true; error = nil
        var lo = Int(low), hi = Int(high); if lo >= hi { lo = hi - 1 }
        let note = why.trimmingCharacters(in: .whitespaces)
        Task {
            do {
                let key = try await catalog.addCustom(label: label.trimmingCharacters(in: .whitespaces),
                                                      low: lo, high: hi, why: note.isEmpty ? nil : note)
                onAdded(key)
                dismiss()
            } catch { self.error = error.localizedDescription; busy = false }
        }
    }
}
