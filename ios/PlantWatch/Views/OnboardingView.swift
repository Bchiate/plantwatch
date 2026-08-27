import SwiftUI

// Plant types are now provided by SpeciesCatalog (data-driven) and presented via
// SpeciesPicker, so this view no longer hardcodes the list.

@MainActor
final class OnboardingModel: ObservableObject {
    enum Step { case connect, organize }
    @Published var step: Step = .connect
    @Published var appKey = ""
    @Published var apiKey = ""
    @Published var error: String?
    @Published var busy = false
    @Published private(set) var gateways: [DiscoveredGateway] = []
    @Published var drafts: [PlantDraft] = []

    func discover() async {
        error = nil; busy = true; defer { busy = false }
        do {
            let gws = try await SensorService.discover(
                appKey: appKey.trimmingCharacters(in: .whitespaces),
                apiKey: apiKey.trimmingCharacters(in: .whitespaces))
            if gws.isEmpty { throw Auth.AuthError.message("No devices found on that Ecowitt account.") }
            gateways = gws
            drafts = gws.flatMap { g in g.channels.map { c in
                PlantDraft(mac: g.mac, gatewayName: g.name, channel: c.channel, moisture: c.moisture,
                           name: "", species: "unknown", zone: GardenZone.normalize(g.name))
            }}
            step = .organize
        } catch { self.error = error.localizedDescription }
    }

    func finish(onDone: @escaping () -> Void) async {
        error = nil; busy = true; defer { busy = false }
        do {
            try await SensorService.save(drafts: drafts, gateways: gateways, markOnboarded: true)
            onDone()
        } catch { self.error = error.localizedDescription }
    }
}

struct OnboardingView: View {
    let onDone: () -> Void
    @StateObject private var model = OnboardingModel()

    var body: some View {
        NavigationStack {
            Group {
                switch model.step {
                case .connect:  connectStep
                case .organize: organizeStep
                }
            }
            .navigationTitle("Set up your garden")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Sign out") { Auth.shared.signOut() } } }
        }
    }

    // Step 1 — Ecowitt keys
    private var connectStep: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Enter the Ecowitt keys for your sensors. Your installer provides these.")
                    .font(.subheadline).foregroundStyle(.secondary)
                field("APPLICATION KEY", text: $model.appKey, placeholder: "Ecowitt Application Key")
                field("API KEY", text: $model.apiKey, placeholder: "Ecowitt API Key")
                if let e = model.error { Text(e).font(.footnote).foregroundStyle(DS.bad).fixedSize(horizontal: false, vertical: true) }
                Button { Task { await model.discover() } } label: {
                    HStack { if model.busy { ProgressView().tint(.white) }; Text("Discover my devices").font(.system(size: 16, weight: .semibold)) }
                        .frame(maxWidth: .infinity).padding(.vertical, 13)
                        .background(DS.brand, in: RoundedRectangle(cornerRadius: 12)).foregroundStyle(.white)
                }
                .buttonStyle(.plain)
                .disabled(model.busy || model.appKey.isEmpty || model.apiKey.isEmpty)
                .opacity((model.busy || model.appKey.isEmpty || model.apiKey.isEmpty) ? 0.6 : 1)
            }
            .padding(20)
        }
    }

    // Step 2 — organize each channel
    private var organizeStep: some View {
        VStack(spacing: 0) {
            Form {
                Section { Text("Name each plant, pick its type, and set its zone. You can change all of this later.").font(.footnote).foregroundStyle(.secondary) }
                ForEach(model.gateways) { gw in
                    Section(gw.name) {
                        ForEach(model.drafts.indices.filter { model.drafts[$0].mac == gw.mac }, id: \.self) { i in
                            VStack(alignment: .leading, spacing: 8) {
                                Text("CH\(model.drafts[i].channel)\(model.drafts[i].moisture != nil ? " · \(Int(model.drafts[i].moisture!))%" : "")")
                                    .font(.caption).foregroundStyle(.secondary)
                                TextField("Plant name", text: $model.drafts[i].name).textFieldStyle(.roundedBorder)
                                SpeciesPicker(selection: $model.drafts[i].species)
                                zonePicker(selection: $model.drafts[i].zone)
                            }
                            .padding(.vertical, 2)
                        }
                    }
                }
                if let e = model.error { Section { Text(e).font(.footnote).foregroundStyle(DS.bad) } }
            }
            Button { Task { await model.finish(onDone: onDone) } } label: {
                HStack { if model.busy { ProgressView().tint(.white) }; Text("Finish setup").font(.system(size: 16, weight: .semibold)) }
                    .frame(maxWidth: .infinity).padding(.vertical, 14)
                    .background(DS.brand, in: RoundedRectangle(cornerRadius: 12)).foregroundStyle(.white)
            }
            .buttonStyle(.plain).disabled(model.busy)
            .padding(.horizontal, 16).padding(.vertical, 10)
        }
    }

    private func zonePicker(selection: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Zone").font(.caption2).foregroundStyle(.secondary)
            Picker("Zone", selection: selection) {
                ForEach(GardenZone.all, id: \.self) { Text(GardenZone.short($0)).tag($0) }
            }
            .pickerStyle(.segmented)
        }
    }

    private func field(_ label: String, text: Binding<String>, placeholder: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.system(size: 11, weight: .semibold)).tracking(0.6).foregroundStyle(.secondary)
            TextField(placeholder, text: text)
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled().textInputAutocapitalization(.never)
        }
    }
}
