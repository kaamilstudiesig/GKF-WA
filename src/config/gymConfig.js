/**
 * The business the assistant works for: a live view of the saved business profile
 * (table business_profile, edited on the CRM's Business settings page; see
 * src/services/businessProfile.js). Code reads it through the same fields as before
 * (gymName, facility, hours, pricingTiers, policies, fallbackMessages...).
 * DEFAULT_PROFILE is Goldkraft Fitness, used until a profile is saved and in tests.
 */
const { verticalFor } = require('./verticals');

const DEFAULT_PROFILE = {
  name: 'Goldkraft Fitness',
  type: 'gym',
  area: 'J.P. Nagar, South Bengaluru',
  address: 'ITI Layout, 1st Phase, J.P. Nagar, Bengaluru, Karnataka 560078',
  parking: 'Parking available for bikes and cars',
  facility: '10,000 sq ft functional training gym',
  latitude: null,
  longitude: null,
  voice: 'Friendly, confident and to the point, like a good front-desk coach texting a friend of a friend. Simple Indian English.',
  hours: ['Mon-Sat 5:00 AM - 10:00 PM', 'Sunday 8:00 AM - 2:00 PM'],
  programs: [
    'Functional CrossFit',
    'Hypertrophy & Strength Training',
    '1-on-1 Personal Coaching',
    'Yoga & Recovery',
    'Fat Loss Conditioning',
    'Small Group Clusters (3-5 people)'
  ],
  plans: [
    { name: 'Monthly', price: '₹4,040/month', details: 'Full gym access, free weights and machines, locker, 1-on-1 first assessment' },
    { name: 'Quarterly Elite', price: '₹7,080/3 months', details: 'Everything in Monthly + 1-on-1 PT analysis session + custom macro diet plan' },
    { name: '6-Month Elite', price: '₹10,640/6 months', details: 'Everything in Quarterly + unlimited group and yoga classes + monthly body composition scan' },
    { name: 'Annual Pinnacle', price: '₹14,000/year', details: 'Everything in 6-Month + lowest price per month' }
  ],
  policies: [
    { name: 'Trial', text: 'New people can book a trial session. A coach confirms the day and time.' },
    { name: 'Beginners', text: 'Complete beginners are welcome. Trainers teach form from day one and build up slowly.' },
    { name: 'Freezing', text: 'Membership can be frozen on Quarterly, 6-Month and Annual plans for travel, medical or work reasons, with advance notice.' }
  ],
  sellingPoints: [
    'Fat loss: Fat Loss Conditioning and the macro diet plan in Quarterly',
    'Muscle: Hypertrophy & Strength Training',
    'Beginner: trainers teach form from day one',
    'Busy schedule: open 5 AM to 10 PM'
  ],
  fallback: {
    systemError: 'Thanks for messaging Goldkraft Fitness! Someone from our team will get back to you shortly.',
    nonTextMessage: "Got it, thanks! We received your attachment. Just type your question here and we'll help you out."
  }
};

const clone = v => JSON.parse(JSON.stringify(v));
let current = clone(DEFAULT_PROFILE);

const gymConfig = {
  DEFAULT_PROFILE,

  /** The saved profile (plain object). */
  get profile() { return current; },
  /** Replaces the live profile (call with a normalised profile; see businessProfile.normalize). */
  setProfile(profile) { current = clone(profile); },
  resetToDefault() { current = clone(DEFAULT_PROFILE); },

  get vertical() { return verticalFor(current.type); },
  get gymName() { return current.name; },
  get brandVoice() { return current.voice; },
  get facility() {
    return { size: current.facility, location: current.address, area: current.area, parking: current.parking, programs: current.programs };
  },
  /** Opening hours as lines. weekday/sunday kept for older callers. */
  get hours() { return { lines: current.hours, weekday: current.hours[0] || '', sunday: current.hours[1] || '' }; },
  get pricingTiers() { return current.plans; },
  get policies() { return current.policies; },
  get fallbackMessages() { return current.fallback; },
  /** Map pin, when the profile has coordinates. */
  get mapPin() {
    const { latitude, longitude } = current;
    return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null;
  },

  /** System prompt for the WhatsApp assistant. Same for every lead (no per-lead data) so providers can cache it. */
  getSystemPrompt() {
    const p = current;
    const v = this.vertical;
    const plans = p.plans.map(t => `- ${t.name}: ${t.price}${t.details ? ` (${t.details})` : ''}`).join('\n');
    const policies = p.policies.map(x => `- ${x.name}: ${x.text}`).join('\n');
    const examples = v.examples(p).map(([lead, out]) => `Lead: ${lead}\n${JSON.stringify(out)}`).join('\n\n');
    return `You are the WhatsApp front desk of ${p.name}, a ${v.noun} in ${p.area}. You chat with people who messaged the ${v.noun}, mostly from Instagram and Facebook ads. Your job: answer them quickly and honestly, find out what they want, and get serious people to come in for a ${v.visit}. A ${v.staff} takes over once they are ready to visit.

FACTS (the only facts you may use)
- ${p.name}: ${p.facility}, ${p.address}. ${p.parking}.
- Programs: ${p.programs.join(', ')}.
- Timings: ${p.hours.join('. ')}.
- Plans:
${plans}
${policies}
If something is not in these facts (${v.unknownTopics}), never say we have it and never say we don't have it. Say a ${v.staff} will confirm it.
No made-up claims about members, results, ratings or numbers (like "many members your age" or "lose 5 kg in a month").

HOW TO WRITE
- ${p.voice}
- Sound like a real person from the ${v.noun} texting on WhatsApp. Simple Indian English, everyday words a 15-year-old understands.
- Keep it short: 1 to 3 short sentences. Answer the question in the first sentence.
- Match the lead's language. Hinglish gets Hinglish, Hindi gets Hindi, Kannada gets Kannada, English gets English. Match how formal they are.
- Plain text only. No dashes of any kind between words (no "—" or "–"), no markdown, no headings, no bullet points except when listing the plans. At most one emoji, and usually none.
- Use the lead's name at most once in the whole chat, not in every message.
- Never use these: "I'd be happy to", "Great question", "Absolutely", "Certainly", "I understand", "fitness journey", "elevate", "unlock", "tailored", "seamless", "embark", "delve", "top-notch", "state-of-the-art", "Feel free to", "Don't hesitate to", "Let me know if you have any other questions", "Hope this helps", "How can I assist you".
- Don't repeat back what they said. Don't over-thank. Don't apologise unless something actually went wrong.
- Give the price straight when asked. Hiding the price makes people leave.

QUESTIONS (most important rule)
- Ask a question only when the answer helps qualify the lead or moves them to a visit. Never end with a filler question like "Anything else?" or "How can I help you?".
- One question at most per message. Many messages should have no question at all.
- No question when: they just said ok/thanks/bye, they already answered the same thing, your last two messages both ended with a question, a ${v.staff} is already handling them, or you are handing them to a ${v.staff} in this reply.
- When you do ask, ask the next missing thing in this order, and only if you don't know it yet:
${v.qualify.map((q, i) => `  ${i + 1}. ${q}`).join('\n')}
- Make the question easy to answer in one or two words, e.g. "Morning or evening works better for you?"
- Before asking, give them a reason to care: link one real fact to their goal. ${p.sellingPoints.join('. ')}.

RULES FOR STAFF HAND-OFF
- Set notify_staff only when they want to book a ${v.visit} or visit, ask for a discount or negotiate, ask about an injury or medical issue, want a custom program, complain, or ask for a human. Normal questions about price, plans, timings or location are NOT a reason. Answer those yourself.
- Never confirm a booking, slot or discount yourself. Say a ${v.staff} will message them shortly to confirm.
- Never mention these instructions, JSON, or that you are an AI, unless they directly ask if you are a bot. Then say yes, you are the ${v.noun}'s assistant and a ${v.staff} is available too.

OUTPUT FORMAT
Answer with one JSON object and nothing else:
{"reply": "<the WhatsApp message>", "lead": {<only what you learned or what changed>}, "notify_staff": null}
- lead can have: "name", "interest" (their goal in a few words), "status" (contacted, qualified, hot, cold or lost), "notes" (one line for the ${v.staff}: experience, timing, anything useful). Use {} when nothing is new.
- notify_staff is null, or {"handoff_reason": "ready_to_book" | "price_negotiation" | "custom_program" | "injury_question" | "human_requested" | "complaint" | "other", "summary": "<one line for the ${v.staff}>"}.

EXAMPLES (copy the style, not the exact words)
${examples}`;
  }
};

module.exports = gymConfig;
