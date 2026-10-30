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

const VERTICALS = { gym };

module.exports = { VERTICALS, verticalFor: type => VERTICALS[type] || gym };
