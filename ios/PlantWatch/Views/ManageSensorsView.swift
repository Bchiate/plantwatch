import SwiftUI

/// "Add / manage sensors" — surfaces sensors that are reporting but not yet
/// labeled, lets the user add them (or mark one as a sensor that physically
/// moved to a new channel), and lets them remove sensors that are no longer
/// reporting. No developer involvement.
@MainActor
final class ManageSensorsModel: ObservableObject {
    @Published var loading = true
    @Published var busy = false
    @Published var error: String?
    @Published private(set) var gateways: [DiscoveredGateway] = []
    @Published var newDrafts: [PlantDraft] = []            // reporting channels not yet configured
    @Published private(set) var offlinePlants: [ExistingPlant] = []  // configured but not reporting now

    var isEmpty: Bool { newDrafts.isEmpty && offlinePlants.isEmpty }

    func reload() async {
        loading = true; error = nil; defer { loading = false }
        do {
            async let discovered = SensorService.discover()
            async let existing = SensorService.existingPlants()
            let gws = try await discovered
            let plants = try await existing
            gateways = gws
            let reporting = Set(gws.flatMap { g in g.channels.map { "\(g.mac)-\($0.channel)" } })
            let have = Set(plants.compactMap { p in p.mac.map { "\($0)-\(p.channel)" } })
            newDrafts = gws.flatMap { g in
                g.channels
                    .filter { !have.contains("\(g.mac)-\($0.channel)") }
                    .map { c in PlantDraft(mac: g.mac, gatewayName: g.name, channel: c.channel,
                                           moisture: c.moisture, name: "", species: "unknown",
                                           zone: GardenZone.normalize(g.name)) }
            }
            offlinePlants = plants.filter { p in
                guard let m = p.mac else { return false }
                return !reporting.contains("\(m)-\(p.channel)")
            }
        } catch { self.error = error.localizedDescription }
    }

    /// Mark a newly-detected channel as an existing sensor that moved: inherit
    /// its name / type / zone and queue the old row for deletion on save.
    func markMoved(_ draftIndex: Int, from plant: ExistingPlant) {
        guard newDrafts.indices.contains(draftIndex) else { return }
        newDrafts[draftIndex].name = plant.name
        newDrafts[draftIndex].species = plant.species ?? "unknown"
        // Keep the zone derived from the sensor's NEW gateway — that reflects
        // where it physically is now. The user can still adjust it below.
        newDrafts[draftIndex].replacesPlantId = plant.id
    }
    func clearMoved(_ draftIndex: Int) {
        guard newDrafts.indices.contains(draftIndex) else { return }
        newDrafts[draftIndex].replacesPlantId = nil
    }
    func movedLabel(for draft: PlantDraft) -> String? {
        guard let pid = draft.replacesPlantId, let p = offlinePlants.first(where: { $0.id == pid }) else { return nil }
        return "Replacing \(p.name) (was CH\(p.channel))"
    }

    func add(onDone: @escaping () -> Void) async {
        busy = true; error = nil; defer { busy = false }
        do {
            try await SensorService.save(drafts: newDrafts, gateways: gateways, markOnboarded: false)
            onDone()
        } catch { self.error = error.localizedDescription }
    }

    func remove(_ plant: ExistingPlant, onChanged: @escaping () -> Void) async {
        busy = true; error = nil; defer { busy = false }
        do {
            try await SensorService.deletePlant(id: plant.id)
            onChanged()
            await reload()
        } catch { self.error = error.localizedDescription }
    }
}

struct ManageSensorsView: View {
    let onChanged: () -> Void
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model = ManageSensorsModel()
    @State private var pendingRemove: ExistingPlant?

    var body: some View {
        NavigationStack {
            Group {
                if model.loading {
                    centered { ProgressView().tint(DS.brand); Text("Checking your sensors…").font(.subheadline).foregroundStyle(.secondary) }
                } else if let e = model.error, model.isEmpty {
                    centered {
                        Image(systemName: "exclamationmark.triangle").font(.system(size: 32)).foregroundStyle(DS.bad)
                        Text(e).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(.horizontal, 30)
                        Button("Try again") { Task { await model.reload() } }.buttonStyle(.borderedProminent).tint(DS.brand)
                    }
                } else if model.isEmpty {
                    centered {
                        Image(systemName: "checkmark.seal.fill").font(.system(size: 40)).foregroundStyle(DS.good)
                        Text("All caught up").font(.title3.bold())
                        Text("Every reporting sensor is labeled and nothing is offline. New or moved sensors show up here automatically once they report.")
                            .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(.horizontal, 32)
                        Button("Check again") { Task { await model.reload() } }.font(.subheadline).foregroundStyle(DS.brandLight)
                    }
                } else {
                    content
                }
            }
            .navigationTitle("Manage sensors")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarLeading) { Button("Done") { dismiss() } } }
        }
        .task { await model.reload() }
        .alert(item: $pendingRemove) { plant in
            Alert(
                title: Text("Remove \(plant.name)?"),
                message: Text("This deletes the sensor from your garden. It's offline now\(plant.gatewayName.map { " on \($0)" } ?? ""). If you moved it to a new spot, cancel and use “This sensor moved” instead."),
                primaryButton: .destructive(Text("Remove")) { Task { await model.remove(plant) { onChanged() } } },
                secondaryButton: .cancel()
            )
        }
    }

    private func centered<C: View>(@ViewBuilder _ c: () -> C) -> some View {
        VStack(spacing: 12) { c() }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var gatewaysWithNew: [DiscoveredGateway] {
        let macs = Set(model.newDrafts.map(\.mac))
        return model.gateways.filter { macs.contains($0.mac) }
    }

    private var content: some View {
        VStack(spacing: 0) {
            Form {
                if !model.newDrafts.isEmpty { newSensorsSections }
                if !model.offlinePlants.isEmpty { offlineSection }
                if let e = model.error { Section { Text(e).font(.footnote).foregroundStyle(DS.bad) } }
            }
            if !model.newDrafts.isEmpty {
                Button { Task { await model.add { onChanged(); dismiss() } } } label: {
                    HStack { if model.busy { ProgressView().tint(.white) }; Text(addButtonTitle).font(.system(size: 16, weight: .semibold)) }
                        .frame(maxWidth: .infinity).padding(.vertical, 14)
                        .background(DS.brand, in: RoundedRectangle(cornerRadius: 12)).foregroundStyle(.white)
                }
                .buttonStyle(.plain).disabled(model.busy)
                .padding(.horizontal, 16).padding(.vertical, 10)
            }
        }
    }

    private var addButtonTitle: String {
        let moved = model.newDrafts.filter { $0.replacesPlantId != nil }.count
        let fresh = model.newDrafts.count - moved
        if moved > 0 && fresh == 0 { return "Update \(moved) moved sensor\(moved == 1 ? "" : "s")" }
        if moved > 0 { return "Save \(model.newDrafts.count) sensors" }
        return "Add \(fresh) sensor\(fresh == 1 ? "" : "s")"
    }

    @ViewBuilder
    private var newSensorsSections: some View {
        Section {
            Text("\(model.newDrafts.count) sensor\(model.newDrafts.count == 1 ? "" : "s") reporting that aren't labeled yet. Name each one — or, if you moved an existing sensor here, mark it as moved.")
                .font(.footnote).foregroundStyle(.secondary)
        }
        ForEach(gatewaysWithNew) { gw in
            Section(gw.name) {
                ForEach(model.newDrafts.indices.filter { model.newDrafts[$0].mac == gw.mac }, id: \.self) { i in
                    newSensorRow(i)
                }
            }
        }
    }

    @ViewBuilder
    private func newSensorRow(_ i: Int) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("CH\(model.newDrafts[i].channel)\(model.newDrafts[i].moisture != nil ? " · \(Int(model.newDrafts[i].moisture!))%" : "")")
                .font(.caption).foregroundStyle(.secondary)

            // Moved-sensor controls
            if let label = model.movedLabel(for: model.newDrafts[i]) {
                HStack(spacing: 8) {
                    Image(systemName: "arrow.uturn.forward.circle.fill").foregroundStyle(DS.brand)
                    Text(label).font(.caption).foregroundStyle(DS.brand)
                    Spacer()
                    Button("Undo") { model.clearMoved(i) }.font(.caption).foregroundStyle(DS.brandLight)
                }
                .padding(8)
                .background(DS.brand.opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
            } else if !model.offlinePlants.isEmpty {
                Menu {
                    ForEach(model.offlinePlants) { p in
                        Button("\(p.name) — CH\(p.channel)\(p.gatewayName.map { " · \($0)" } ?? "")") { model.markMoved(i, from: p) }
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "arrow.left.arrow.right")
                        Text("This sensor moved from…").font(.caption)
                    }
                    .foregroundStyle(DS.brandLight)
                }
            }

            TextField("Plant name", text: $model.newDrafts[i].name).textFieldStyle(.roundedBorder)
            SpeciesPicker(selection: $model.newDrafts[i].species)
            VStack(alignment: .leading, spacing: 4) {
                Text("Zone").font(.caption2).foregroundStyle(.secondary)
                Picker("Zone", selection: $model.newDrafts[i].zone) {
                    ForEach(GardenZone.all, id: \.self) { Text(GardenZone.short($0)).tag($0) }
                }
                .pickerStyle(.segmented)
            }
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private var offlineSection: some View {
        Section {
            ForEach(model.offlinePlants) { p in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(p.name).font(.system(size: 15, weight: .medium))
                        Text("CH\(p.channel)\(p.gatewayName.map { " · \($0)" } ?? "")\(p.zoneName.map { " · \($0)" } ?? "")")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button(role: .destructive) { pendingRemove = p } label: {
                        Image(systemName: "trash").foregroundStyle(DS.bad)
                    }
                    .buttonStyle(.borderless)
                }
            }
        } header: {
            Text("Offline sensors")
        } footer: {
            Text(model.newDrafts.isEmpty
                 ? "These aren't reporting right now. If you just moved one to a new spot, give it a few minutes to start reporting, then tap Done and reopen this screen — it'll appear up top as a new sensor you can mark as moved."
                 : "These aren't reporting right now. If you moved one to a new spot, find its new channel above and tap “This sensor moved from…” instead of removing it.")
        }
    }
}
