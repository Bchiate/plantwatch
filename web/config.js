// Where the dashboard fetches plant data from.
// Set `endpoint` to the deployed Supabase edge-function URL.
window.PLANTWATCH_CONFIG = {
  endpoint: "https://your-project-ref.supabase.co/functions/v1/plant-report",
  // anonKey not required — the function is deployed with verify_jwt=false
  // (single trusted audience, per spec).
  anonKey: "",
};
