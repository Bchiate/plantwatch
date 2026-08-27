import SwiftUI

// MARK: - Models (match admin-overview JSON)

private struct AdminOverview: Decodable {
    let generated_at: String?
    let user_count: Int?
    let triage: [TriageItem]?
    let users: [AdminUser]
}
private struct Diagnosis: Decodable, Hashable {
    let severity: String; let category: String; let headline: String; let detail: String
    let fix_steps: [String]; let needs_battery: Bool
}
private struct TriageItem: Decodable, Identifiable, Hashable {
    let scope: String; let severity: String; let category: String
    let client: String
    let gateway_name: String?; let zone: String?; let plant: String?; let channel: Int?
    let headline: String; let detail: String?; let fix_steps: [String]?
    let sensor_count: Int?; let moisture: Double?; let battery: Double?; let battery_class: String?
    let last_seen: String?; let offline_age_sec: Int?; let needs_battery: Bool?
    var id: String { "\(client)|\(scope)|\(plant ?? gateway_name ?? "")|\(channel ?? -1)|\(category)" }
}
private struct AdminCounts: Decodable {
    var good: Int?; var dry: Int?; var too_wet: Int?; var offline: Int?; var unassigned: Int?
    var low_batt: Int?; var critical_batt: Int?; var gateway_down: Int?; var needs_water: Int?
}
private struct AdminReading: Decodable, Identifiable {
    let zone: String?; let physical_zone: String?; let channel: Int; let name: String
    let moisture: Double?; let status: String; let headline: String
    let ideal_low: Int?; let ideal_high: Int?; let advice: String?; let watering: String?
    let battery: Double?; let battery_class: String?; let is_offline: Bool?
    let last_seen: String?; let offline_age_sec: Int?; let diagnosis: Diagnosis?
    var id: Int { channel }
}
private struct AdminUser: Decodable, Identifiable {
    let user_id: String; let email: String; let garden_name: String
    let is_admin: Bool; let onboarded: Bool; let has_ecowitt: Bool; let gateway_count: Int
    let created_at: String?; let last_sign_in_at: String?
    let counts: AdminCounts; let readings: [AdminReading]
    var id: String { user_id }
}

// MARK: - Helpers

private let iso: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }()
private let isoPlain = ISO8601DateFormatter()
private func parseDate(_ s: String?) -> Date? { guard let s else { return nil }; return iso.date(from: s) ?? isoPlain.date(from: s) }
private func relative(_ s: String?) -> String {
    guard let d = parseDate(s) else { return "—" }
    let f = RelativeDateTimeFormatter(); f.unitsStyle = .abbreviated
    return f.localizedString(for: d, relativeTo: Date())
}
private func ageStr(_ sec: Int?) -> String? {
    guard let s = sec else { return nil }
    let h = s / 3600, m = (s % 3600) / 60
    return h > 0 ? "\(h)h \(m)m" : "\(m)m"
}
private func sevColor(_ s: String) -> Color {
    switch s { case "critical": return DS.bad; case "warning": return Color(red:0.85,green:0.5,blue:0.25); case "info": return Color(red:0.25,green:0.53,blue:0.85); default: return DS.good }
}
private func battColor(_ c: String?) -> Color {
    switch c { case "critical": return DS.bad; case "low": return Color(red:0.85,green:0.5,blue:0.25); case "good": return DS.good; default: return .secondary }
}
private func statusColor(_ s: String) -> Color {
    switch s { case "good": return DS.good; case "dry": return Color(red:0.85,green:0.5,blue:0.25); case "very_dry": return DS.bad
    case "too_wet": return Color(red:0.25,green:0.53,blue:0.85); case "unassigned": return Color(red:0.54,green:0.39,blue:0.82); default: return .secondary }
}
private func statusLabel(_ s: String) -> String {
    ["good":"Good","dry":"Dry","very_dry":"Very dry","too_wet":"Too wet","unassigned":"Set type","no_reading":"Offline"][s] ?? s
}
private func catBadge(_ c: String) -> String {
    ["gateway_down":"GATEWAY","offline_sensor":"OFFLINE","low_batt":"LOW BATT","welfare_dry":"DRY","welfare_wet":"WET","unassigned":"NO TYPE"][c] ?? c.uppercased()
}

// MARK: - Model

@MainActor
private final class AdminModel: ObservableObject {
    @Published var loading = true
    @Published var error: String?
    @Published var users: [AdminUser] = []
    @Published var triage: [TriageItem] = []
    @Published var updated: Date?

    func load() async {
        loading = true; error = nil; defer { loading = false }
        do {
            let data = try await Auth.shared.authed("functions/v1/admin-overview")
            let o = try JSONDecoder().decode(AdminOverview.self, from: data)
            users = o.users.filter { !($0.is_admin && $0.readings.isEmpty) }
            triage = o.triage ?? []
            updated = Date()
        } catch { self.error = (error as? Auth.AuthError)?.errorDescription ?? error.localizedDescription }
    }
}

// MARK: - Dashboard

struct AdminDashboardView: View {
    @StateObject private var model = AdminModel()

    private var crit: Int { model.triage.filter { $0.severity == "critical" }.count }
    private var warn: Int { model.triage.filter { $0.severity == "warning" }.count }
    private var info: Int { model.triage.filter { $0.severity == "info" }.count }

    var body: some View {
        NavigationStack {
            Group {
                if model.loading && model.users.isEmpty {
                    VStack(spacing: 12) { ProgressView().tint(DS.brand); Text("Checking every yard…").font(.subheadline).foregroundStyle(.secondary) }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let e = model.error, model.users.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "exclamationmark.triangle").font(.system(size: 30)).foregroundStyle(DS.bad)
                        Text(e).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(.horizontal, 30)
                        Button("Try again") { Task { await model.load() } }.buttonStyle(.borderedProminent).tint(DS.brand)
                    }.frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    list
                }
            }
            .navigationTitle("Sensor Health")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Menu {
                        if let e = Auth.shared.email { Text(e) }
                        Button(role: .destructive) { Auth.shared.signOut() } label: { Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right") }
                    } label: { Image(systemName: "person.crop.circle") }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { Task { await model.load() } } label: { Image(systemName: "arrow.clockwise") }.disabled(model.loading)
                }
            }
            .refreshable { await model.load() }
        }
        .task { await model.load() }
    }

    private var list: some View {
        List {
            // Triage
            Section {
                if model.triage.isEmpty {
                    HStack(spacing: 10) {
                        Image(systemName: "checkmark.seal.fill").foregroundStyle(DS.good)
                        Text("All sensors healthy — nothing needs attention.").font(.subheadline)
                    }.padding(.vertical, 4)
                } else {
                    ForEach(model.triage) { t in
                        NavigationLink { TriageDetailView(item: t) } label: { triageRow(t) }
                    }
                }
            } header: {
                HStack {
                    Text("Needs attention")
                    Spacer()
                    if crit > 0 { pill("\(crit)", DS.bad) }
                    if warn > 0 { pill("\(warn)", sevColor("warning")) }
                    if info > 0 { pill("\(info)", sevColor("info")) }
                }
            }

            // Clients
            Section("Customers") {
                ForEach(model.users) { u in
                    NavigationLink { AdminUserDetail(user: u) } label: { clientRow(u) }
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    private func pill(_ t: String, _ c: Color) -> some View {
        Text(t).font(.system(size: 11, weight: .bold)).padding(.horizontal, 7).padding(.vertical, 2)
            .background(c.opacity(0.18), in: Capsule()).foregroundStyle(c)
    }

    private func triageRow(_ t: TriageItem) -> some View {
        let loc = t.scope == "gateway" ? "\(t.gateway_name ?? "Gateway") — \(t.sensor_count ?? 0) sensors dark"
                                       : "\(t.plant ?? "") · \(t.zone ?? "") · CH\(t.channel ?? 0)"
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Circle().fill(sevColor(t.severity)).frame(width: 9, height: 9)
                Text(catBadge(t.category)).font(.system(size: 10, weight: .bold))
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(sevColor(t.severity).opacity(0.16), in: Capsule()).foregroundStyle(sevColor(t.severity))
                Spacer()
                if let a = ageStr(t.offline_age_sec) { Text("offline \(a)").font(.caption2).foregroundStyle(.secondary) }
                if t.needs_battery == true { Text("🔋 L91").font(.caption2) }
            }
            Text("\(t.client) · \(loc)").font(.system(size: 13, weight: .medium))
            Text(t.headline).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }.padding(.vertical, 3)
    }

    private func clientRow(_ u: AdminUser) -> some View {
        let c = u.counts
        let offline = (c.offline ?? 0), low = (c.low_batt ?? 0) + (c.critical_batt ?? 0)
        let total = u.readings.count
        let online = total - offline
        let worst: Color = offline > 0 ? DS.bad : (low > 0 ? sevColor("warning") : DS.good)
        return VStack(alignment: .leading, spacing: 5) {
            HStack {
                Circle().fill(worst).frame(width: 9, height: 9)
                Text(u.garden_name).font(.system(size: 15, weight: .semibold))
                Spacer()
                Text("\(online)/\(total) online").font(.caption).foregroundStyle(.secondary)
            }
            HStack(spacing: 6) {
                if offline > 0 { mini("\(offline) offline", DS.bad) }
                if low > 0 { mini("\(low) low batt", sevColor("warning")) }
                if (c.too_wet ?? 0) > 0 { mini("\((c.too_wet ?? 0)) wet", sevColor("info")) }
                if (c.dry ?? 0) > 0 { mini("\((c.dry ?? 0)) dry", sevColor("warning")) }
                if (c.good ?? 0) > 0 { mini("\((c.good ?? 0)) good", DS.good) }
            }
            Text("active \(relative(u.last_sign_in_at))").font(.caption2).foregroundStyle(.secondary)
        }.padding(.vertical, 3)
    }
    private func mini(_ t: String, _ c: Color) -> some View {
        Text(t).font(.system(size: 10, weight: .semibold)).padding(.horizontal, 6).padding(.vertical, 2)
            .background(c.opacity(0.15), in: Capsule()).foregroundStyle(c)
    }
}

// MARK: - Shared diagnosis panel

private struct DiagPanel: View {
    let severity: String; let headline: String; let detail: String
    let fixSteps: [String]; let needsBattery: Bool
    @State private var done: Set<Int> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text(headline).font(.headline).foregroundStyle(sevColor(severity))
                Text(detail).font(.subheadline).foregroundStyle(.primary).fixedSize(horizontal: false, vertical: true)
            }
            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .background(sevColor(severity).opacity(0.10), in: RoundedRectangle(cornerRadius: 12))

            if needsBattery {
                HStack(alignment: .top, spacing: 8) {
                    Text("🔋")
                    Text("Bring an **Energizer Ultimate Lithium L91 (AA)** — flat ~1.5 V that won't sag in heat. Don't use rechargeable NiMH.")
                        .font(.caption).foregroundStyle(.primary)
                }
                .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(red:0.85,green:0.5,blue:0.25).opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
            }

            if !fixSteps.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("FIX STEPS").font(.system(size: 11, weight: .semibold)).tracking(0.6).foregroundStyle(.secondary)
                    ForEach(Array(fixSteps.enumerated()), id: \.offset) { i, step in
                        Button { if done.contains(i) { done.remove(i) } else { done.insert(i) } } label: {
                            HStack(alignment: .top, spacing: 10) {
                                Image(systemName: done.contains(i) ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(done.contains(i) ? DS.good : .secondary)
                                Text(step).font(.subheadline).foregroundStyle(done.contains(i) ? .secondary : .primary)
                                    .strikethrough(done.contains(i)).fixedSize(horizontal: false, vertical: true)
                                Spacer(minLength: 0)
                            }
                        }.buttonStyle(.plain)
                    }
                }
            }
        }
    }
}

// MARK: - Triage detail

private struct TriageDetailView: View {
    let item: TriageItem
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.client).font(.title3.bold())
                    Text(item.scope == "gateway"
                         ? "\(item.gateway_name ?? "Gateway") · \(item.sensor_count ?? 0) sensors"
                         : "\(item.plant ?? "") · \(item.zone ?? "") · CH\(item.channel ?? 0)")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                // vitals
                HStack(spacing: 8) {
                    if let m = item.moisture { vital("\(Int(m))%", "moisture", .secondary) }
                    if let b = item.battery { vital("\(b)V", "battery", battColor(item.battery_class)) }
                    if let a = ageStr(item.offline_age_sec) { vital(a, "offline", DS.bad) }
                }
                DiagPanel(severity: item.severity, headline: item.headline, detail: item.detail ?? "",
                          fixSteps: item.fix_steps ?? [], needsBattery: item.needs_battery ?? false)
            }.padding(20)
        }
        .navigationTitle("Diagnose").navigationBarTitleDisplayMode(.inline)
    }
    private func vital(_ v: String, _ l: String, _ c: Color) -> some View {
        VStack(spacing: 2) { Text(v).font(.system(size: 17, weight: .bold)).foregroundStyle(c); Text(l).font(.caption2).foregroundStyle(.secondary) }
            .frame(maxWidth: .infinity).padding(.vertical, 8)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10))
    }
}

// MARK: - Per-client detail

private struct AdminUserDetail: View {
    let user: AdminUser
    var body: some View {
        List {
            Section("App usage") {
                row("Last active", relative(user.last_sign_in_at))
                row("Joined", parseDate(user.created_at).map { $0.formatted(date: .abbreviated, time: .omitted) } ?? "—")
                row("Onboarded", user.onboarded ? "Yes" : "No")
                row("Email", user.email)
            }
            Section("\(user.readings.count) sensor\(user.readings.count == 1 ? "" : "s")") {
                ForEach(user.readings.sorted { $0.channel < $1.channel }) { r in
                    NavigationLink { SensorDetailView(reading: r, client: user.garden_name) } label: { sensorRow(r) }
                }
            }
        }
        .navigationTitle(user.garden_name).navigationBarTitleDisplayMode(.inline)
    }
    private func sensorRow(_ r: AdminReading) -> some View {
        HStack {
            Circle().fill(statusColor(r.status)).frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 2) {
                Text(r.name).font(.system(size: 15, weight: .medium))
                Text("CH\(r.channel) · \(r.physical_zone ?? r.zone ?? "")").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(r.moisture != nil ? "\(Int(r.moisture!))%" : "offline").font(.system(size: 15, weight: .bold)).monospacedDigit()
                    .foregroundStyle(r.moisture != nil ? .primary : DS.bad)
                if let b = r.battery { Text("🔋 \(b)V").font(.caption2).foregroundStyle(battColor(r.battery_class)) }
            }
        }
    }
    private func row(_ k: String, _ v: String) -> some View {
        HStack { Text(k).foregroundStyle(.secondary); Spacer(); Text(v) }.font(.subheadline)
    }
}

// MARK: - Per-sensor detail

private struct SensorDetailView: View {
    let reading: AdminReading
    let client: String
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(reading.name).font(.title3.bold())
                    Text("\(client) · \(reading.physical_zone ?? reading.zone ?? "") · CH\(reading.channel)")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                HStack(spacing: 8) {
                    vital(reading.moisture != nil ? "\(Int(reading.moisture!))%" : "—", reading.moisture != nil ? "moisture" : "offline", reading.moisture != nil ? statusColor(reading.status) : DS.bad)
                    if let lo = reading.ideal_low, let hi = reading.ideal_high { vital("\(lo)–\(hi)", "ideal", .secondary) }
                    if let b = reading.battery { vital("\(b)V", "battery", battColor(reading.battery_class)) }
                    if let a = ageStr(reading.offline_age_sec) { vital(a, "offline", DS.bad) }
                }
                if let d = reading.diagnosis {
                    DiagPanel(severity: d.severity, headline: d.headline, detail: d.detail, fixSteps: d.fix_steps, needsBattery: d.needs_battery)
                }
                if let w = reading.watering {
                    Text("💧 \(w)").font(.subheadline).foregroundStyle(DS.brandLight)
                }
            }.padding(20)
        }
        .navigationTitle("CH\(reading.channel)").navigationBarTitleDisplayMode(.inline)
    }
    private func vital(_ v: String, _ l: String, _ c: Color) -> some View {
        VStack(spacing: 2) { Text(v).font(.system(size: 16, weight: .bold)).foregroundStyle(c); Text(l).font(.caption2).foregroundStyle(.secondary) }
            .frame(maxWidth: .infinity).padding(.vertical, 8)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10))
    }
}
