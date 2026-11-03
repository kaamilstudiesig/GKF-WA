/**
 * Vertical packs: how the assistant sells for a type of business. The business's own
 * facts come from its profile (src/config/gymConfig.js); this is the selling method.
 * Add a pack per vertical (clinic, salon, coaching institute, real estate…).
 */

const firstMatch = (items, re) => items.find(i => re.test(i)) || items[0] || 'our programs';

const gym = {
  type: 'gym',
  label: 'Gym / fitness studio',
  noun: 'gym',
  visit: 'trial',
  staff: 'coach',
  unknownTopics: 'offers, discounts, trainer names, class timetable, ladies batch, steam, sauna, diet details',
  qualify: [
    'Goal (fat loss, muscle, strength, general fitness, sport, recovery)',
    'Experience (new to gym, coming back after a break, training now)',
    'Timing (when they want to start, morning or evening)',
    'Visit (which day they can come for the trial)'
  ],
  goalQuestion: 'fat loss ya muscle',
  // Words for the fixed (free) replies in src/services/deterministicRouter.js.
  words: {
    visit: { enA: 'a trial', hi: 'trial', kn: 'ಟ್ರಯಲ್' },
    staff: { en: 'a coach', hi: 'coach', hiWill: 'dega', kn: 'ಕೋಚ್' },
    plans: { en: 'membership plans', hi: 'membership plans', kn: 'ಸದಸ್ಯತ್ವ ಯೋಜನೆಗಳು' },
    pricesAsk: {
      en: "Longer plans work out cheaper per month. What's your main goal, fat loss or muscle? I'll tell you which plan fits.",
      hi: 'Lamba plan per month sasta padta hai. Aapka main goal kya hai, fat loss ya muscle?',
      kn: 'ದೀರ್ಘ ಯೋಜನೆ ತಿಂಗಳಿಗೆ ಕಡಿಮೆ ಬೀಳುತ್ತದೆ. ನಿಮ್ಮ ಮುಖ್ಯ ಗುರಿ ಏನು, ತೂಕ ಇಳಿಕೆಯೋ ಮಸಲ್ ಬೆಳವಣಿಗೆಯೋ?'
    },
    bookButton: 'Book a trial',
    staffButton: 'Talk to a coach'
  },
  examples(profile) {
    const [a, b] = profile.plans;
    const plansLine = a && b
      ? `${a.name} is ${a.price}. ${b.name} is ${b.price}, which works out cheaper per month.`
      : a ? `${a.name} is ${a.price}.` : 'A coach will share the plans with you.';
    const fatLoss = firstMatch(profile.programs, /fat|weight|conditioning/i);
    return [
      ['price kya hai monthly?', { reply: `${plansLine} Aapka goal kya hai, fat loss ya muscle?`, lead: { status: 'contacted', interest: 'membership price' }, notify_staff: null }],
      ['I want to lose 10 kg', { reply: `Very doable. ${fatLoss} is what most people here start with for that. Have you trained in a gym before or starting fresh?`, lead: { interest: 'fat loss, 10 kg', status: 'qualified' }, notify_staff: null }],
      ['starting fresh, a bit scared tbh', { reply: 'Totally normal, everyone starts somewhere. Trainers teach you form from day one and build up slowly, so no pressure. Want to come in for a trial this week?', lead: { notes: 'Beginner, a bit nervous' }, notify_staff: null }],
      ['saturday morning works', { reply: 'Perfect, Saturday morning it is. A coach will message you shortly to confirm the exact time.', lead: { status: 'hot', notes: 'Wants trial Saturday morning' }, notify_staff: { handoff_reason: 'ready_to_book', summary: 'Beginner, fat loss, wants trial Saturday morning' } }],
      ['ok thanks', { reply: 'Anytime! Just message here when you want to visit.', lead: {}, notify_staff: null }]
    ];
  }
};

/**
 * General preset for any business where people book a visit, call or appointment
 * (clinics, salons, coaching, real estate, services). Used until a business type
 * gets its own pack.
 */
const services = {
  type: 'services',
  label: 'Other business (services, appointments)',
  noun: 'business',
  visit: 'visit',
  staff: 'team member',
  unknownTopics: 'offers, discounts, staff names, exact availability, anything not listed in the facts',
  qualify: [
    'Need (what they want and why now)',
    'Fit (which plan, service or option matches them)',
    'Timing (when they want to start or buy)',
    'Visit (which day they can come in or take a call)'
  ],
  goalQuestion: 'aapko kis cheez ki zaroorat hai',
  words: {
    visit: { enA: 'a visit', hi: 'visit', kn: 'ಭೇಟಿ' },
    staff: { en: 'someone from our team', hi: 'humari team', hiWill: 'denge', kn: 'ನಮ್ಮ ತಂಡ' },
    plans: { en: 'plans and prices', hi: 'plans aur prices', kn: 'ಯೋಜನೆಗಳು ಮತ್ತು ಬೆಲೆಗಳು' },
    pricesAsk: {
      en: 'What are you looking for exactly? I will tell you which option fits.',
      hi: 'Aapko exactly kya chahiye? Main bata dunga kaunsa option sahi rahega.',
      kn: 'ನಿಮಗೆ ನಿಖರವಾಗಿ ಏನು ಬೇಕು? ಯಾವ ಆಯ್ಕೆ ಸೂಕ್ತ ಎಂದು ತಿಳಿಸುತ್ತೇನೆ.'
    },
    bookButton: 'Book a visit',
    staffButton: 'Talk to us'
  },
  examples(profile) {
    const [a] = profile.plans;
    const priceLine = a ? `${a.name} is ${a.price}.` : 'Someone from our team will share the prices with you.';
    return [
      ['price kya hai?', { reply: `${priceLine} Aapko exactly kis cheez ki zaroorat hai?`, lead: { status: 'contacted', interest: 'price' }, notify_staff: null }],
      ['I need this soon, maybe this week', { reply: 'That works. What day suits you to come in or take a quick call?', lead: { status: 'qualified', notes: 'Wants it this week' }, notify_staff: null }],
      ['thursday evening', { reply: 'Done, Thursday evening. Someone from our team will message you shortly to confirm the time.', lead: { status: 'hot', notes: 'Visit Thursday evening' }, notify_staff: { handoff_reason: 'ready_to_book', summary: 'Wants a visit Thursday evening' } }],
      ['ok thanks', { reply: 'Anytime! Just message here when you are ready.', lead: {}, notify_staff: null }]
    ];
  }
};

const VERTICALS = { gym, services };

module.exports = { VERTICALS, verticalFor: type => VERTICALS[type] || gym };
