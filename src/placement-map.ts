/**
 * The Cloudflare placement region next to a D1 database (2026-11-11, the owner's decision: "as close to
 * the D1 as possible"). Every name here was accepted by Cloudflare on a test Worker on 2026-11-11.
 * No Workers API here, so the map can be tested alone.
 */
const BY_COLO: Record<string, string> = {
  NRT: "aws:ap-northeast-1", HND: "aws:ap-northeast-1",
  KIX: "aws:ap-northeast-3",
  ICN: "aws:ap-northeast-2",
  SIN: "aws:ap-southeast-1",
  HKG: "gcp:asia-east2",
  BOM: "aws:ap-south-1",
  SYD: "aws:ap-southeast-2", MEL: "aws:ap-southeast-2",
  FRA: "aws:eu-central-1",
  AMS: "gcp:europe-west4",
  CDG: "aws:eu-west-3",
  LHR: "aws:eu-west-2",
  DUB: "aws:eu-west-1",
  WAW: "gcp:europe-central2",
  IAD: "aws:us-east-1", EWR: "aws:us-east-1", ATL: "aws:us-east-1", MIA: "aws:us-east-1",
  ORD: "gcp:us-central1", DFW: "gcp:us-central1",
  SJC: "aws:us-west-1", LAX: "aws:us-west-1",
  SEA: "aws:us-west-2", PDX: "aws:us-west-2",
};

/** When D1 names a location the table does not know, the middle of its region. */
const BY_REGION: Record<string, string> = {
  APAC: "aws:ap-northeast-1",
  OC: "aws:ap-southeast-2",
  WEUR: "aws:eu-west-1",
  EEUR: "gcp:europe-central2",
  ENAM: "aws:us-east-1",
  WNAM: "aws:us-west-2",
};

export function placementOfD1(colo: string | undefined, region: string | undefined): string | undefined {
  return (colo && BY_COLO[colo.toUpperCase()]) || (region && BY_REGION[region.toUpperCase()]) || undefined;
}
