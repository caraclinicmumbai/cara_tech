// One-off: seed example chatbot flows + a test lead for safe end-to-end testing.
// Stage flows are scoped to the `test_bot` campaign so they can only fire for the
// seeded test lead — never real patients. Idempotent (clears prior [TEST] flows +
// the test lead first). Run with the target DATABASE_URL loaded.
import { prisma } from "../lib/prisma";
import { Prisma } from "@prisma/client";

// Pass the tester's WhatsApp number via TEST_PHONE (E.164), e.g.
//   TEST_PHONE="+91XXXXXXXXXX" npx tsx scripts/seedTestChatbots.ts
const TEST_PHONE = process.env.TEST_PHONE || "";
const TEST_CAMPAIGN = "test_bot";

const sendText = (id: string, text: string) => ({ id, type: "send_text", position: { x: 250, y: 0 }, data: { text } });
const edge = (id: string, source: string, target: string, sourceHandle = "out") => ({ id, source, target, sourceHandle });
const trigger = { id: "trigger", type: "trigger", position: { x: 250, y: -120 }, data: {} };

// Linear flow: trigger → one send_text.
function linear(text: string) {
  return { nodes: [trigger, sendText("t1", text)], edges: [edge("e0", "trigger", "t1")] };
}

const flows = [
  {
    name: "[TEST] In Consideration",
    triggerEvent: "stage_change",
    triggerConfig: { stage: "in_consideration", campaign: TEST_CAMPAIGN },
    graph: linear("Hi {{name}}! 👋 Still considering your treatment at Cara Clinic? Reply here and our team will gladly help with any questions."),
  },
  {
    name: "[TEST] Appointment Scheduled",
    triggerEvent: "stage_change",
    triggerConfig: { stage: "appointment_scheduled", campaign: TEST_CAMPAIGN },
    graph: linear("✅ {{name}}, your appointment at Cara Clinic is confirmed! We look forward to seeing you. Reply RESCHEDULE if the time doesn't work for you."),
  },
  {
    name: "[TEST] Consultation Done",
    triggerEvent: "stage_change",
    triggerConfig: { stage: "consultation_done", campaign: TEST_CAMPAIGN },
    graph: {
      nodes: [
        trigger,
        sendText("t1", "Thank you for visiting Cara Clinic, {{name}}! 🙏"),
        { id: "a1", type: "ask_text", position: { x: 250, y: 120 }, data: { prompt: "How was your consultation experience? (reply in a line)", variable: "feedback" } },
        sendText("t2", "Thanks for the feedback, {{name}} — we've noted it! 💚"),
      ],
      edges: [edge("e0", "trigger", "t1"), edge("e1", "t1", "a1"), edge("e2", "a1", "t2")],
    },
  },
  {
    name: "[TEST] Lost",
    triggerEvent: "stage_change",
    triggerConfig: { stage: "lost", campaign: TEST_CAMPAIGN },
    graph: linear("We're sorry to see you go, {{name}}. If you change your mind, our team at Cara Clinic is always here to help. 💚"),
  },
  {
    // Interactive demo — keyword-gated to "testbot" so it can't fire on normal chats.
    name: "[TEST] Welcome buttons (keyword: testbot)",
    triggerEvent: "keyword",
    triggerConfig: { value: "testbot" },
    graph: {
      nodes: [
        trigger,
        { id: "b", type: "send_buttons", position: { x: 250, y: 0 }, data: { text: "Hi {{name}}! Welcome to Cara Clinic. How can we help you today?", buttons: ["Book appointment", "Get info", "Call me"] } },
        sendText("y0", "Great! 📅 Our team will help you book your appointment."),
        sendText("y1", "Cara Clinic offers hair transplants & aesthetic treatments in Mumbai. Ask us anything!"),
        sendText("y2", "No problem — we'll call you shortly! 📞"),
      ],
      edges: [
        edge("e0", "trigger", "b"),
        edge("e1", "b", "y0", "btn-0"),
        edge("e2", "b", "y1", "btn-1"),
        edge("e3", "b", "y2", "btn-2"),
      ],
    },
  },
];

async function main() {
  if (!TEST_PHONE) throw new Error("Set TEST_PHONE (E.164) — the tester's WhatsApp number.");
  // Idempotent cleanup.
  const del = await prisma.chatbotFlow.deleteMany({ where: { name: { startsWith: "[TEST]" } } });
  const last10 = TEST_PHONE.replace(/\D/g, "").slice(-10);
  await prisma.lead.deleteMany({ where: { phone: { contains: last10 }, campaign: TEST_CAMPAIGN } });
  console.log(`Cleared ${del.count} prior [TEST] flow(s).`);

  for (const f of flows) {
    await prisma.chatbotFlow.create({
      data: {
        name: f.name,
        triggerEvent: f.triggerEvent,
        triggerConfig: f.triggerConfig as Prisma.InputJsonValue,
        active: true,
        priority: "high",
        graph: f.graph as Prisma.InputJsonValue,
      },
    });
    console.log(`  + ${f.name}`);
  }

  const lead = await prisma.lead.create({
    data: {
      name: "Chatbot Tester",
      phone: TEST_PHONE,
      campaign: TEST_CAMPAIGN,
      source: "manual",
      stage: "ai_contacted",
    },
  });
  console.log(`Test lead created: ${lead.name} (${TEST_PHONE.slice(0, 3)}…), campaign=${TEST_CAMPAIGN}, stage=ai_contacted`);
  console.log("Done.");
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
