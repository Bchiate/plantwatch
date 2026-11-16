import { assert, assertEquals } from "@std/assert";
import {
  classifyApiError,
  ECOWITT_API,
  fetchGatewayReadings,
  fetchLastSeen,
  formatEcowittDate,
  isTransient,
  latestValidTimestamp,
  listDevices,
  parseNumber,
  parseSoilChannels,
} from "./ecowitt.ts";
import { fakeFetch, jsonResponse, on } from "./fake_fetch.ts";
import type { SourceError } from "./report.ts";

const CREDS = { appKey: "APP-KEY", apiKey: "API-KEY" };
const MAC = "00:00:5E:00:53:01"; // documentation-range MAC (RFC 7042)

/** Retry without waiting, so tests of failures stay fast. */
const NO_WAIT = { sleep: () => Promise.resolve() };

function realtime(data: unknown) {
  return jsonResponse({ code: 0, msg: "success", time: "1790000000", data });
}

/** Answers each call with the next response in the list, then repeats the last one. */
function sequence(...responses: Array<() => Response | Promise<Response>>) {
  let i = 0;
  return fakeFetch(() => responses[Math.min(i++, responses.length - 1)]());
}

const LIVE_DATA = {
  soil_ch1: { soilmoisture: { time: "1790000000", unit: "%", value: "34" } },
  soil_ch3: { soilmoisture: { time: "1790000000", unit: "%", value: "51" } },
  soil_ch4: { soilmoisture: { time: "1790000000", unit: "%", value: "-" } },
  battery: {
    soilmoisture_sensor_ch1: { unit: "V", value: "1.6" },
    soilmoisture_sensor_ch3: { unit: "V", value: "1.3" },
  },
};

Deno.test("parseSoilChannels: reads moisture and battery; skips channels without data", () => {
  assertEquals(parseSoilChannels(LIVE_DATA), {
    1: { moisture: 34, battery: 1.6 },
    3: { moisture: 51, battery: 1.3 },
  });
  assertEquals(parseSoilChannels([]), {}, "an offline gateway can return an empty array");
  assertEquals(parseSoilChannels(null), {});
  assertEquals(parseSoilChannels({ soil_ch2: { soilmoisture: { value: "40" } } }), {
    2: { moisture: 40, battery: null },
  });
});

Deno.test("parseNumber: Ecowitt's string numbers", () => {
  assertEquals(parseNumber("34"), 34);
  assertEquals(parseNumber("1.6"), 1.6);
  assertEquals(parseNumber(12), 12);
  for (const v of ["-", "", "  ", null, undefined, Number.NaN, {}, "abc"]) {
    assertEquals(parseNumber(v), null, String(v));
  }
});

Deno.test("classifyApiError: credential and device codes are recognised", () => {
  assertEquals(classifyApiError(40011, "Illegal Api_Key Parameter").kind, "auth");
  assertEquals(classifyApiError(40010, "x").kind, "auth");
  assertEquals(classifyApiError(40012, "Illegal MAC").kind, "device");
  assertEquals(classifyApiError(-1, "System is busy"), {
    kind: "api",
    message: "System is busy",
    code: -1,
  });
  assertEquals(classifyApiError(45001, "").message, "Ecowitt error 45001");
});

Deno.test("fetchGatewayReadings: success sends the keys and returns channels", async () => {
  const { fetch, calls } = fakeFetch(
    on(`${ECOWITT_API}/device/real_time`, () => realtime(LIVE_DATA)),
  );
  const result = await fetchGatewayReadings(fetch, CREDS, MAC);
  assertEquals(result, {
    ok: true,
    channels: { 1: { moisture: 34, battery: 1.6 }, 3: { moisture: 51, battery: 1.3 } },
  });
  const params = calls[0].url.searchParams;
  assertEquals(params.get("application_key"), "APP-KEY");
  assertEquals(params.get("api_key"), "API-KEY");
  assertEquals(params.get("mac"), MAC);
});

Deno.test("fetchGatewayReadings: failures are reported, never turned into empty data", async () => {
  const cases: Array<[string, () => Response | Promise<Response>, string, number | null]> = [
    [
      "rejected key",
      () => jsonResponse({ code: 40011, msg: "Illegal Api_Key Parameter", data: [] }),
      "auth",
      40011,
    ],
    ["unknown MAC", () => jsonResponse({ code: 40012, msg: "Illegal MAC" }), "device", 40012],
    ["HTTP 503", () => new Response("busy", { status: 503 }), "http", 503],
    ["bad JSON", () => new Response("<html>", { status: 200 }), "api", null],
    ["network", () => Promise.reject(new TypeError("connection reset")), "network", null],
    [
      "timeout",
      () => Promise.reject(new DOMException("signal timed out", "TimeoutError")),
      "timeout",
      null,
    ],
  ];
  for (const [label, respond, kind, code] of cases) {
    const { fetch } = fakeFetch(() => respond());
    const result = await fetchGatewayReadings(fetch, CREDS, MAC, NO_WAIT);
    assert(!result.ok, label);
    assertEquals(result.error.kind, kind, label);
    assertEquals(result.error.code, code, label);
    assert(!result.error.message.includes("API-KEY"), `${label}: message must not echo keys`);
  }
});

Deno.test("retries: blips are tried again, waiting 0.5 s and then 1 s", async () => {
  const waits: number[] = [];
  const { fetch, calls } = sequence(
    () => new Response("busy", { status: 503 }),
    () => jsonResponse({ code: -1, msg: "System is busy" }),
    () => realtime(LIVE_DATA),
  );
  const result = await fetchGatewayReadings(fetch, CREDS, MAC, {
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });
  assert(result.ok);
  assertEquals(Object.keys(result.channels), ["1", "3"]);
  assertEquals(calls.length, 3);
  assertEquals(waits, [500, 1000]);
});

Deno.test("retries: gives up after three attempts and reports the last failure", async () => {
  const { fetch, calls } = sequence(() => jsonResponse({ code: 45001, msg: "Too frequent" }));
  const result = await fetchGatewayReadings(fetch, CREDS, MAC, NO_WAIT);
  assert(!result.ok);
  assertEquals([result.error.kind, result.error.code], ["api", 45001]);
  assertEquals(calls.length, 3);

  const once = sequence(() => new Response("busy", { status: 503 }));
  await fetchGatewayReadings(once.fetch, CREDS, MAC, { ...NO_WAIT, attempts: 1 });
  assertEquals(once.calls.length, 1, "attempts: 1 turns retrying off");
});

Deno.test("retries: rejected keys, an unknown gateway and a timeout are never retried", async () => {
  const definitive: Array<[string, () => Response | Promise<Response>]> = [
    ["rejected key", () => jsonResponse({ code: 40011, msg: "Illegal Api_Key Parameter" })],
    ["unknown MAC", () => jsonResponse({ code: 40012, msg: "Illegal MAC" })],
    ["HTTP 404", () => new Response("not found", { status: 404 })],
    ["timeout", () => Promise.reject(new DOMException("signal timed out", "TimeoutError"))],
  ];
  for (const [label, respond] of definitive) {
    const { fetch, calls } = sequence(respond);
    const result = await fetchGatewayReadings(fetch, CREDS, MAC, NO_WAIT);
    assert(!result.ok, label);
    assertEquals(calls.length, 1, label);
  }
});

Deno.test("retries: an empty reading is tried again only when asked", async () => {
  const empty = () => realtime([]);
  const retryEmpty = { ...NO_WAIT, retryEmptyData: true };

  const blip = sequence(empty, () => realtime(LIVE_DATA));
  const recovered = await fetchGatewayReadings(blip.fetch, CREDS, MAC, retryEmpty);
  assert(recovered.ok);
  assertEquals(Object.keys(recovered.channels), ["1", "3"]);
  assertEquals(blip.calls.length, 2);

  const offline = sequence(empty);
  assertEquals(
    await fetchGatewayReadings(offline.fetch, CREDS, MAC, retryEmpty),
    { ok: true, channels: {} },
    "a hub that stays empty ends as 'no reading', not as an error",
  );
  assertEquals(offline.calls.length, 3);

  const plain = sequence(empty);
  await fetchGatewayReadings(plain.fetch, CREDS, MAC, NO_WAIT);
  assertEquals(plain.calls.length, 1, "not retried unless asked");
});

Deno.test("isTransient: only failures that can clear on their own", () => {
  const cases: Array<[SourceError["kind"], number | null, boolean]> = [
    ["network", null, true],
    ["http", 500, true],
    ["http", 503, true],
    ["http", 429, true],
    ["http", 404, false],
    ["api", null, true], // empty or non-JSON body
    ["api", -1, true], // system busy
    ["api", 45001, true], // called too often
    ["api", 40000, false],
    ["auth", 40011, false],
    ["device", 40012, false],
    ["timeout", null, false],
  ];
  for (const [kind, code, expected] of cases) {
    assertEquals(isTransient({ kind, code, message: "x" }), expected, `${kind} ${code}`);
  }
});

Deno.test("latestValidTimestamp: newest real value wins", () => {
  const data = {
    soil_ch2: {
      soilmoisture: {
        list: { "1790000000": "33", "1790001800": "34", "1790003600": "-", "1790005400": "" },
      },
    },
  };
  assertEquals(latestValidTimestamp(data, 2), new Date(1790001800 * 1000).toISOString());
  assertEquals(latestValidTimestamp(data, 3), null);
  assertEquals(latestValidTimestamp([], 2), null);
});

Deno.test("fetchLastSeen: widens the window from 3 to 90 days, and gives up on errors", async () => {
  const now = new Date("2026-10-06T12:00:00Z");
  const empty = { code: 0, msg: "success", data: [] };
  const found = {
    code: 0,
    msg: "success",
    data: { soil_ch5: { soilmoisture: { list: { "1788000000": "29" } } } },
  };
  let call = 0;
  const { fetch, calls } = fakeFetch(() => jsonResponse(call++ === 0 ? empty : found));
  const seen = await fetchLastSeen(fetch, CREDS, MAC, 5, now, "Europe/Berlin");
  assertEquals(seen, new Date(1788000000 * 1000).toISOString());
  assertEquals(calls.length, 2);
  assertEquals(calls[0].url.searchParams.get("call_back"), "soil_ch5");
  assertEquals(calls[1].url.searchParams.get("start_date"), "2026-07-08 14:00:00");
  assertEquals(calls[1].url.searchParams.get("end_date"), "2026-10-06 14:00:00");

  const failing = fakeFetch(() => jsonResponse({ code: 40011, msg: "bad key" }));
  assertEquals(await fetchLastSeen(failing.fetch, CREDS, MAC, 5, now, null), null);
  assertEquals(failing.calls.length, 1, "no second lookup after an API error");

  const busy = sequence(() => new Response("busy", { status: 503 }));
  assertEquals(await fetchLastSeen(busy.fetch, CREDS, MAC, 5, now, null), null);
  assertEquals(busy.calls.length, 1, "last-seen lookups get one attempt, even for a blip");
});

Deno.test("formatEcowittDate: local time in the gateway's zone, 24-hour, UTC fallback", () => {
  const midnightUtc = new Date("2026-01-15T00:05:09Z");
  assertEquals(formatEcowittDate(midnightUtc, null), "2026-01-15 00:05:09");
  assertEquals(formatEcowittDate(midnightUtc, "Not/AZone"), "2026-01-15 00:05:09");
  assertEquals(formatEcowittDate(midnightUtc, "America/New_York"), "2026-01-14 19:05:09");
  assertEquals(formatEcowittDate(midnightUtc, "Asia/Tokyo"), "2026-01-15 09:05:09");
});

Deno.test("listDevices: normalises names, coordinates and time zones", async () => {
  // Example coordinates: London city centre.
  const { fetch } = fakeFetch(on(`${ECOWITT_API}/device/list`, () =>
    jsonResponse({
      code: 0,
      msg: "success",
      data: {
        list: [
          {
            mac: MAC,
            name: " Garden hub ",
            stationtype: "GW1100A",
            latitude: "51.5072",
            longitude: "-0.1276",
            date_zone_id: "Europe/London",
          },
          { mac: "00:00:5E:00:53:02", name: "", stationtype: "GW1200B", latitude: 0, longitude: 0 },
          { mac: "", name: "ignored: no MAC" },
        ],
      },
    })));
  const result = await listDevices(fetch, CREDS);
  assert(result.ok);
  assertEquals(result.devices, [
    {
      mac: MAC,
      name: "Garden hub",
      stationType: "GW1100A",
      latitude: 51.5072,
      longitude: -0.1276,
      timeZone: "Europe/London",
    },
    {
      mac: "00:00:5E:00:53:02",
      name: "GW1200B",
      stationType: "GW1200B",
      latitude: null,
      longitude: null,
      timeZone: null,
    },
  ]);
});
