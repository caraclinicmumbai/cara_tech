import "dotenv/config";
import axios from "axios";

async function twilio() {
  const sid = process.env.TWILIO_ACCOUNT_SID!, token = process.env.TWILIO_AUTH_TOKEN!;
  const auth = { username: sid, password: token };
  console.log("── TWILIO ──");
  const acct = await axios.get(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, { auth });
  console.log(`  account      : ${acct.data.friendly_name} · type=${acct.data.type} · status=${acct.data.status}`);
  console.log(`  created      : ${acct.data.date_created}`);
  const bal = await axios.get(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Balance.json`, { auth });
  console.log(`  balance      : ${bal.data.currency} ${bal.data.balance}  (prepaid — no renewal date)`);
  const nums = await axios.get(`https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json?PageSize=50`, { auth });
  console.log(`  numbers owned: ${nums.data.incoming_phone_numbers.length}`);
  for (const n of nums.data.incoming_phone_numbers) {
    console.log(`     ${n.phone_number}  (${n.friendly_name}) voice=${n.capabilities?.voice} sms=${n.capabilities?.sms} since ${String(n.date_created).slice(0,16)}`);
  }
}

async function elevenlabs() {
  console.log("\n── ELEVENLABS ──");
  const r = await axios.get("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY! } });
  const d = r.data;
  console.log(`  tier          : ${d.tier} · status=${d.status}`);
  console.log(`  characters    : ${d.character_count?.toLocaleString()} used of ${d.character_limit?.toLocaleString()}`);
  console.log(`  period resets : ${d.next_character_count_reset_unix ? new Date(d.next_character_count_reset_unix*1000).toISOString().slice(0,10) : "?"}`);
  console.log(`  billing period: ${d.billing_period ?? "?"} · currency=${d.currency ?? "?"}`);
  console.log(`  overflow/extra: allowed=${d.can_extend_character_limit} · voice slots=${d.voice_limit ?? "?"}`);
}

async function meta() {
  console.log("\n── META / WHATSAPP ──");
  const t = process.env.WHATSAPP_TOKEN!, waba = process.env.WHATSAPP_WABA_ID!, v = process.env.META_GRAPH_VERSION ?? "v21.0";
  const w = await axios.get(`https://graph.facebook.com/${v}/${waba}?fields=name,currency,account_review_status,timezone_id,message_template_namespace`, { headers: { Authorization: `Bearer ${t}` } });
  console.log(`  WABA          : ${w.data.name} · review=${w.data.account_review_status} · currency=${w.data.currency ?? "?"}`);
  const p = await axios.get(`https://graph.facebook.com/${v}/${process.env.WHATSAPP_PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier,status`, { headers: { Authorization: `Bearer ${t}` } });
  console.log(`  number        : ${p.data.display_phone_number} (${p.data.verified_name}) status=${p.data.status} quality=${p.data.quality_rating} tier=${p.data.messaging_limit_tier ?? "?"}`);
}

async function slack() {
  console.log("\n── SLACK ──");
  const r = await axios.post("https://slack.com/api/team.info", {}, { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } });
  if (r.data.ok) console.log(`  workspace     : ${r.data.team.name} (${r.data.team.domain}.slack.com) id=${r.data.team.id}`);
  else console.log(`  team.info     : ${r.data.error} (needs team:read scope — plan not readable from the API)`);
}

async function anthropic() {
  console.log("\n── ANTHROPIC ──");
  const r = await axios.get("https://api.anthropic.com/v1/models", { headers: { "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" }, validateStatus: () => true });
  console.log(`  key           : ${r.status === 200 ? "valid" : "HTTP " + r.status}`);
  console.log(`  model in use  : ${process.env.CQS_MODEL ?? "(default)"}`);
  console.log("  spend/credits : not exposed by the API — read from console.anthropic.com");
}

async function misc() {
  console.log("\n── OTHER CONFIGURED ENDPOINTS ──");
  for (const [k, label] of [["N8N_WEBHOOK_NEW_LEAD","n8n workflow host"],["GOOGLE_LEADFORM_KEY","Google lead-form intake"],["META_PAGE_ACCESS_TOKEN","Meta Lead Ads"],["DATABASE_URL","Postgres"],["REDIS_URL","Redis"],["NEXTAUTH_URL","Deployed URL"]]) {
    const v = process.env[k];
    const shown = !v ? "NOT SET" : k.endsWith("URL") ? String(v).replace(/\/\/[^@]*@/, "//***@") : "set";
    console.log(`  ${label.padEnd(24)}: ${shown}`);
  }
}

(async () => {
  for (const f of [twilio, elevenlabs, meta, slack, anthropic, misc]) {
    try { await f(); } catch (e: any) { console.log(`  ERROR: ${e?.response?.status ?? ""} ${e?.response?.data?.error?.message ?? e.message}`); }
  }
  process.exit(0);
})();
