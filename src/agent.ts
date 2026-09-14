import OpenAI from "openai";
import { DateTime } from "luxon";
import { env } from "./config";
import type { Barber } from "./db/barbers";
import {
  appendMessages,
  getRecentMessages,
  setCustomerName,
  type Customer,
  type StoredMessage,
} from "./db/conversations";
import {
  getUpcomingForCustomer,
  markCancelled,
  recordAppointment,
} from "./db/appointments";
import {
  bookAppointment,
  cancelAppointment,
  findAvailableSlots,
  formatSlotLabel,
} from "./calendar/booking";
import { ReauthRequiredError } from "./calendar/client";

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

const MAX_TOOL_ROUNDS = 5;
const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function humanHours(barber: Barber): string {
  return DAY_NAMES.map((name, day) => {
    const ranges = barber.hours.get(day);
    return ranges?.length
      ? `${name}: ${ranges.map((r) => `${clock(r.startMinutes)}-${clock(r.endMinutes)}`).join(", ")}`
      : `${name}: closed`;
  }).join("\n");
}

function systemPrompt(barber: Barber, customer: Customer): string {
  const now = DateTime.now().setZone(barber.timezone);
  const upcoming = getUpcomingForCustomer(customer.id);

  return [
    `You are the SMS booking assistant for ${barber.shop_name}, a barbershop. The barber is ${barber.display_name}.`,
    `You are texting with the customer at ${customer.phone}. Everything you write is sent as an SMS.`,
    customer.name
      ? `You already know this customer's name: ${customer.name}.`
      : ``,
    ``,
    `Right now it is ${now.toFormat("cccc, LLLL d yyyy 'at' h:mm a ZZZZ")} (${barber.timezone}).`,
    `A haircut takes ${barber.appointment_duration_minutes} minutes. Customers can book up to`,
    `${barber.booking_window_days} days out, with at least ${barber.min_lead_time_minutes} minutes of notice.`,
    ``,
    `Shop hours (${barber.timezone}):`,
    humanHours(barber),
    ``,
    upcoming.length
      ? `This customer already has these appointments booked:\n${upcoming
          .map(
            (a) =>
              `- ${formatSlotLabel(a.starts_at, barber.timezone)} for ${a.customer_name} (event ${a.google_event_id})`,
          )
          .join("\n")}`
      : `This customer has no upcoming appointments.`,
    ``,
    `How to behave:`,
    `- Always call check_availability before naming any times. Never invent or guess open slots.`,
    `- Offer at most 3 options at a time, written naturally, e.g. "Tue Sep 15 at 2:00 PM".`,
    `- You need the customer's name before booking. If you don't have it, ask for it in the same message as the times.`,
    `- Only call book_appointment with a start time that check_availability returned in this conversation.`,
    `- After booking succeeds, confirm the day, date, and time back to them in plain language.`,
    `- If a slot was taken, apologize briefly, pull fresh availability, and offer alternatives.`,
    `- For anything you can't do (pricing, walk-ins, running late), say the barber will follow up. Never make up shop policy.`,
    ``,
    `Style: warm, brief, plain text. No markdown, no emoji unless they use one first, under 320 characters.`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "check_availability",
      description:
        "Look up open haircut slots on the barber's calendar. Call this before offering any times to the customer.",
      parameters: {
        type: "object",
        properties: {
          fromDate: {
            type: "string",
            description:
              "Shop-local start date, YYYY-MM-DD. Defaults to today.",
          },
          toDate: {
            type: "string",
            description:
              "Shop-local end date (inclusive), YYYY-MM-DD. Defaults to a week after fromDate.",
          },
          earliestTime: {
            type: "string",
            description:
              'Earliest shop-local start time, HH:MM 24h. Use for requests like "afternoon" (13:00).',
          },
          latestTime: {
            type: "string",
            description:
              'Latest shop-local start time, HH:MM 24h. Use for requests like "before noon" (12:00).',
          },
          maxResults: {
            type: "integer",
            description: "How many slots to return. Default 6, max 20.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "book_appointment",
      description:
        "Book the haircut on the barber's Google Calendar. Only use a start time returned by check_availability.",
      parameters: {
        type: "object",
        properties: {
          startIso: {
            type: "string",
            description:
              "Exact `start` value from a check_availability result, e.g. 2026-09-15T14:00:00-04:00.",
          },
          customerName: {
            type: "string",
            description: "The customer's name, as they gave it.",
          },
          notes: {
            type: "string",
            description:
              "Optional requests the customer mentioned, e.g. beard trim.",
          },
        },
        required: ["startIso", "customerName"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_appointment",
      description:
        "Cancel one of this customer's existing appointments and remove it from the barber's calendar.",
      parameters: {
        type: "object",
        properties: {
          eventId: {
            type: "string",
            description:
              "The event id listed in this customer's upcoming appointments.",
          },
        },
        required: ["eventId"],
        additionalProperties: false,
      },
    },
  },
];

export type BookingEvent = {
  eventId: string;
  start: string;
  label: string;
  customerName: string;
};

export type AgentResult = {
  reply: string;
  /** Set when this turn actually created a calendar event, so the caller can notify the barber. */
  booking?: BookingEvent;
};

type ToolContext = {
  barber: Barber;
  customer: Customer;
  booking?: BookingEvent;
};

async function runTool(
  name: string,
  rawArgs: string,
  ctx: ToolContext,
): Promise<unknown> {
  let args: Record<string, unknown>;
  try {
    args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
  } catch {
    return { error: "Arguments were not valid JSON. Try again." };
  }

  switch (name) {
    case "check_availability": {
      const slots = await findAvailableSlots(ctx.barber, {
        fromDate: args.fromDate as string | undefined,
        toDate: args.toDate as string | undefined,
        earliestTime: args.earliestTime as string | undefined,
        latestTime: args.latestTime as string | undefined,
        maxResults: args.maxResults as number | undefined,
      });
      return slots.length
        ? { slots }
        : {
            slots: [],
            note: "No openings in that range. Try a wider date range or different time of day.",
          };
    }

    case "book_appointment": {
      const startIso = args.startIso as string | undefined;
      const customerName = (args.customerName as string | undefined)?.trim();
      if (!startIso || !customerName)
        return { error: "Both startIso and customerName are required." };

      const result = await bookAppointment(ctx.barber, {
        startIso,
        customerName,
        customerPhone: ctx.customer.phone,
        notes: args.notes as string | undefined,
      });

      if (!result.ok)
        return {
          booked: false,
          reason: result.reason,
          message: result.message,
        };

      if (ctx.customer.name !== customerName) {
        setCustomerName(ctx.customer.id, customerName);
        ctx.customer.name = customerName;
      }

      recordAppointment({
        barberId: ctx.barber.id,
        customerId: ctx.customer.id,
        googleEventId: result.eventId,
        customerName,
        startsAt: result.start,
        endsAt: result.end,
      });
      ctx.booking = {
        eventId: result.eventId,
        start: result.start,
        label: result.label,
        customerName,
      };

      return {
        booked: true,
        eventId: result.eventId,
        when: result.label,
        start: result.start,
      };
    }

    case "cancel_appointment": {
      const eventId = args.eventId as string | undefined;
      if (!eventId) return { error: "eventId is required." };

      const owned = getUpcomingForCustomer(ctx.customer.id).some(
        (a) => a.google_event_id === eventId,
      );
      if (!owned)
        return { error: "That appointment doesn't belong to this customer." };

      await cancelAppointment(ctx.barber, eventId);
      markCancelled(ctx.barber.id, eventId);
      return { cancelled: true };
    }

    default:
      return { error: `Unknown tool "${name}".` };
  }
}

export async function handleCustomerMessage(
  barber: Barber,
  customer: Customer,
  text: string,
): Promise<AgentResult> {
  const history = getRecentMessages(customer.id);
  const turn: StoredMessage[] = [{ role: "user", content: text }];
  const ctx: ToolContext = { barber, customer };

  const FALLBACK_REPLY = `Sorry, I'm having trouble on my end right now. Text back in a few minutes and I'll get you booked.`;
  let reply: string | null = null;

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const completion = await openai.chat.completions.create({
        model: env.OPENAI_MODEL,
        tools,
        messages: [
          { role: "system", content: systemPrompt(barber, customer) },
          ...history,
          ...turn,
        ] as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      });

      const message = completion.choices[0]?.message;
      if (!message) break;

      const toolCalls = message.tool_calls ?? [];

      // Persist only the fields the API accepts back on replay.
      turn.push({
        role: "assistant",
        content: message.content ?? null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });

      if (toolCalls.length === 0) {
        reply = message.content?.trim() || null;
        break;
      }

      for (const call of toolCalls) {
        if (call.type !== "function") continue;
        let output: unknown;
        try {
          output = await runTool(
            call.function.name,
            call.function.arguments,
            ctx,
          );
        } catch (error) {
          if (error instanceof ReauthRequiredError) throw error;
          console.error(`[agent] tool ${call.function.name} failed`, error);
          output = {
            error:
              "That lookup failed. Tell the customer you'll follow up shortly.",
          };
        }
        turn.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(output),
        });
      }
    }
  } catch (error) {
    if (error instanceof ReauthRequiredError) {
      // Nothing the customer says can fix this, so don't persist a misleading transcript turn.
      throw error;
    }
    console.error("[agent] completion failed", error);
  }

  if (reply === null) {
    // The model ran out of tool rounds or the call failed; close the turn ourselves so the
    // stored transcript always ends on a plain assistant message.
    reply = FALLBACK_REPLY;
    turn.push({ role: "assistant", content: reply });
  }

  appendMessages(customer.id, turn);

  return ctx.booking ? { reply, booking: ctx.booking } : { reply };
}
