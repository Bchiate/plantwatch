import Foundation

// Shared models + service for discovering and saving sensors. Used by both the
// first-run onboarding and the "Add / manage sensors" screen.

/// The three physical zones the dashboard renders. A sensor MUST be assigned to
/// one of these or it won't appear on the dashboard, so the UI only ever lets
/// the user pick from here and we normalize any raw gateway/zone name onto it.
enum GardenZone {
    static let all = ["Back Yard", "Side Yards", "Front Yard"]
    /// Best-effort map a raw gateway/zone name onto one of the three buckets.
    static func normalize(_ raw: String?) -> String {
        let s = (raw ?? "").lowercased()
        if let exact = all.first(where: { $0.lowercased() == s }) { return exact }
        if s.contains("front") { return "Front Yard" }
        if s.contains("side")  { return "Side Yards" }
        return "Back Yard"
    }
    /// Short label for tight segmented controls.
    static func short(_ z: String) -> String {
        switch z {
        case "Back Yard":  return "Back"
        case "Side Yards": return "Side"
        case "Front Yard": return "Front"
        default:           return z
        }
    }
}

struct DiscoveredChannel: Decodable, Identifiable {
    let channel: Int; let moisture: Double?; let battery: Double?
    var id: Int { channel }
}
struct DiscoveredGateway: Decodable, Identifiable {
    let mac: String; let name: String; let station_type: String?
    let latitude: Double?; let longitude: Double?
    let channels: [DiscoveredChannel]
    var id: String { mac }
}
private struct DevicesResponse: Decodable { let gateways: [DiscoveredGateway]?; let error: String? }

struct PlantDraft: Identifiable {
    let id = UUID()
    let mac: String
    let gatewayName: String
    let channel: Int
    let moisture: Double?
    var name: String
    var species: String
    var zone: String
    /// When this draft is a sensor that physically moved, the id of the old
    /// (now-offline) plant it replaces. That row is deleted on save.
    var replacesPlantId: Int? = nil
}

/// An already-configured plant, used to offer "this sensor moved" + removal.
struct ExistingPlant: Identifiable {
    let id: Int
    let name: String
    let species: String?
    let channel: Int
    let zoneId: Int?
    let zoneName: String?
    let mac: String?
    let gatewayName: String?
    let idealLow: Int?
    let idealHigh: Int?
}

enum SensorService {
    /// Discover all gateways + active channels using the account's saved Ecowitt keys.
    static func discover() async throws -> [DiscoveredGateway] {
        try await discover(body: [:])
    }
    /// Discover with freshly-entered keys (also saves them to the account).
    static func discover(appKey: String, apiKey: String) async throws -> [DiscoveredGateway] {
        try await discover(body: ["app_key": appKey, "api_key": apiKey, "save": true])
    }
    private static func discover(body: [String: Any]) async throws -> [DiscoveredGateway] {
        let data = try await Auth.shared.authed("functions/v1/ecowitt-devices", method: "POST", json: body)
        let resp = try JSONDecoder().decode(DevicesResponse.self, from: data)
        if let e = resp.error { throw Auth.AuthError.message(e) }
        return resp.gateways ?? []
    }

    /// The (mac, channel) pairs already configured as plants on this account.
    static func existingChannels() async throws -> Set<String> {
        let gwData = try await Auth.shared.authed("rest/v1/gateways?select=id,mac")
        let gws = (try? JSONSerialization.jsonObject(with: gwData) as? [[String: Any]]) ?? []
        var macById: [Int: String] = [:]
        for g in gws { if let i = g["id"] as? Int, let m = g["mac"] as? String { macById[i] = m } }
        let pData = try await Auth.shared.authed("rest/v1/plants?select=gateway_id,channel")
        let plants = (try? JSONSerialization.jsonObject(with: pData) as? [[String: Any]]) ?? []
        var set = Set<String>()
        for p in plants { if let gid = p["gateway_id"] as? Int, let ch = p["channel"] as? Int, let m = macById[gid] { set.insert("\(m)-\(ch)") } }
        return set
    }

    /// All configured plants with their gateway MAC + zone name (for the
    /// "moved sensor" and "remove offline sensor" flows).
    static func existingPlants() async throws -> [ExistingPlant] {
        let data = try await Auth.shared.authed("rest/v1/plants?select=id,name,species,channel,zone_id,ideal_low,ideal_high,gateways(mac,name),zones(name)&order=display_order")
        let rows = (try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]) ?? []
        return rows.compactMap { r in
            guard let id = r["id"] as? Int, let ch = r["channel"] as? Int, let name = r["name"] as? String else { return nil }
            let gw = r["gateways"] as? [String: Any]
            let zn = r["zones"] as? [String: Any]
            return ExistingPlant(
                id: id, name: name, species: r["species"] as? String, channel: ch,
                zoneId: r["zone_id"] as? Int, zoneName: zn?["name"] as? String,
                mac: gw?["mac"] as? String, gatewayName: gw?["name"] as? String,
                idealLow: r["ideal_low"] as? Int, idealHigh: r["ideal_high"] as? Int)
        }
    }

    /// Permanently remove a plant (e.g. a decommissioned or replaced sensor).
    static func deletePlant(id: Int) async throws {
        _ = try await Auth.shared.authed("rest/v1/plants?id=eq.\(id)", method: "DELETE", prefer: "return=minimal")
    }

    /// Two sensors were physically swapped, so each channel now reads the other
    /// plant's soil. Swap the plant identity + care (name, species, zone, ideal
    /// range) between the two channels — channels stay fixed, so the readings
    /// line up again with the right plant and no channel numbers are touched.
    static func swapPlants(aZone: String, aChannel: Int, bZone: String, bChannel: Int) async throws {
        let plants = try await existingPlants()
        func find(_ z: String, _ c: Int) -> ExistingPlant? {
            plants.first { ($0.gatewayName ?? "") == z && $0.channel == c }
        }
        guard let a = find(aZone, aChannel), let b = find(bZone, bChannel) else {
            throw Auth.AuthError.message("Couldn't find both sensors to swap.")
        }
        func body(_ p: ExistingPlant) -> [String: Any] {
            [ "name": p.name,
              "species": p.species ?? "unknown",
              "zone_id": p.zoneId.map { $0 as Any } ?? NSNull(),
              "ideal_low": p.idealLow.map { $0 as Any } ?? NSNull(),
              "ideal_high": p.idealHigh.map { $0 as Any } ?? NSNull() ]
        }
        // Write B's identity onto A's channel, and A's onto B's.
        _ = try await Auth.shared.authed("rest/v1/plants?id=eq.\(a.id)", method: "PATCH", json: body(b), prefer: "return=minimal")
        _ = try await Auth.shared.authed("rest/v1/plants?id=eq.\(b.id)", method: "PATCH", json: body(a), prefer: "return=minimal")
    }

    /// Insert plants for the given drafts, creating any missing zones/gateways.
    /// Idempotent: re-adding an existing (gateway, channel) is a no-op.
    static func save(drafts: [PlantDraft], gateways: [DiscoveredGateway], markOnboarded: Bool) async throws {
        let userId = await Auth.shared.userId
        guard !drafts.isEmpty, let uid = userId else {
            if markOnboarded, let uid = userId {
                _ = try await Auth.shared.authed("rest/v1/profiles?id=eq.\(uid)", method: "PATCH", json: ["onboarded": true], prefer: "return=minimal")
            }
            return
        }

        // 1) Zones — reuse existing by name, create the rest.
        let zData = try await Auth.shared.authed("rest/v1/zones?select=id,name")
        let existingZones = (try? JSONSerialization.jsonObject(with: zData) as? [[String: Any]]) ?? []
        var zoneId: [String: Int] = [:]
        for z in existingZones { if let n = z["name"] as? String, let i = z["id"] as? Int { zoneId[n] = i } }
        let wanted = Set(drafts.map { $0.zone.trimmingCharacters(in: .whitespaces).isEmpty ? "My Garden" : $0.zone.trimmingCharacters(in: .whitespaces) })
        let toCreate = wanted.subtracting(zoneId.keys)
        if !toCreate.isEmpty {
            let body = toCreate.enumerated().map { ["user_id": uid, "name": $0.element, "sort": zoneId.count + $0.offset] as [String: Any] }
            let created = try await Auth.shared.authed("rest/v1/zones?select=id,name", method: "POST", json: body, prefer: "return=representation")
            let rows = (try? JSONSerialization.jsonObject(with: created) as? [[String: Any]]) ?? []
            for z in rows { if let n = z["name"] as? String, let i = z["id"] as? Int { zoneId[n] = i } }
        }

        // 2) Gateways — upsert (unique on user_id,mac), reuse ids.
        let gData = try await Auth.shared.authed("rest/v1/gateways?select=id,mac")
        let existingGws = (try? JSONSerialization.jsonObject(with: gData) as? [[String: Any]]) ?? []
        var gwId: [String: Int] = [:]
        for g in existingGws { if let m = g["mac"] as? String, let i = g["id"] as? Int { gwId[m] = i } }
        let macsNeeded = Set(drafts.map { $0.mac })
        let gwsToCreate = gateways.filter { macsNeeded.contains($0.mac) && gwId[$0.mac] == nil }
        if !gwsToCreate.isEmpty {
            let body = gwsToCreate.map { ["user_id": uid, "mac": $0.mac, "name": $0.name, "station_type": $0.station_type ?? ""] as [String: Any] }
            let created = try await Auth.shared.authed("rest/v1/gateways?select=id,mac", method: "POST", json: body, prefer: "return=representation,resolution=merge-duplicates")
            let rows = (try? JSONSerialization.jsonObject(with: created) as? [[String: Any]]) ?? []
            for g in rows { if let m = g["mac"] as? String, let i = g["id"] as? Int { gwId[m] = i } }
        }

        // 3) Plants — merge-duplicates so re-adding is safe.
        var order = (existingZones.count) + 100
        let plantBody: [[String: Any]] = drafts.compactMap { d in
            guard let gid = gwId[d.mac] else { return nil }
            order += 1
            let nm = d.name.trimmingCharacters(in: .whitespaces)
            let zn = d.zone.trimmingCharacters(in: .whitespaces).isEmpty ? "My Garden" : d.zone.trimmingCharacters(in: .whitespaces)
            var row: [String: Any] = ["user_id": uid, "gateway_id": gid, "channel": d.channel,
                "name": nm.isEmpty ? "CH\(d.channel)" : nm, "species": d.species, "display_order": order]
            if let zid = zoneId[zn] { row["zone_id"] = zid }
            return row
        }
        if !plantBody.isEmpty {
            _ = try await Auth.shared.authed("rest/v1/plants", method: "POST", json: plantBody, prefer: "resolution=merge-duplicates,return=minimal")
        }

        // 3b) Delete the old rows for any sensors that physically moved channel.
        // The new row above carries the moved sensor's label/zone; drop the stale one.
        for oldId in Set(drafts.compactMap { $0.replacesPlantId }) {
            _ = try await Auth.shared.authed("rest/v1/plants?id=eq.\(oldId)", method: "DELETE", prefer: "return=minimal")
        }

        // 4) Mark onboarded (first run only)
        if markOnboarded {
            _ = try await Auth.shared.authed("rest/v1/profiles?id=eq.\(uid)", method: "PATCH", json: ["onboarded": true], prefer: "return=minimal")
        }
    }
}
