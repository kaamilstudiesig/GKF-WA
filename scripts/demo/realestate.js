/**
 * R14 demo pack: real estate. Everything here is made up: project names, people,
 * phone numbers (test ranges only) and prices. No real person or project.
 * Two regions: 'ae' (Dubai: AED, English + Arabic + Hinglish) and 'in' (Bengaluru:
 * ₹, English + Hinglish). Used by scripts/demo.js.
 */

const REGIONS = {
  ae: {
    currency: 'AED',
    // +971 50 000 xxxx (12 digits): a reserved-looking test range, never a real customer.
    phone: n => `97150000${String(1000 + n).slice(-4)}`,
    area: 'Dubai',
    address: 'Office 1204, Demo Tower, Business Bay, Dubai (sample address)',
    projects: [
      { name: 'Palm Crest Residences', area: 'Dubai Hills' },
      { name: 'Marina Vista', area: 'Dubai Marina' },
      { name: 'Creekside Gardens', area: 'Dubai Creek Harbour' }
    ],
    units: [
      { name: 'Studio', price: 'AED 750K onwards', from: 750000, to: 900000, details: 'Furnished option, pool and gym' },
      { name: '1 Bedroom', price: 'AED 1.1M onwards', from: 1100000, to: 1450000, details: 'Balcony, community view' },
      { name: '2 Bedroom', price: 'AED 1.8M onwards', from: 1800000, to: 2400000, details: 'Maid room option, park view' },
      { name: '3 Bedroom Townhouse', price: 'AED 3.2M onwards', from: 3200000, to: 3900000, details: 'Private garden, 2 parking' }
    ],
    policies: [
      { name: 'Booking', text: 'A unit is reserved with a 10% booking amount. The advisor shares the payment plan.' },
      { name: 'Payment plan', text: 'Most projects have a 60/40 plan: 60% during construction, 40% on handover.' },
      { name: 'Site visits', text: 'Site visits every day 10 AM to 7 PM. The advisor confirms the time.' },
      { name: 'Mortgage', text: 'Our advisor can introduce mortgage partners. Approval depends on the bank.' }
    ],
    sellingPoints: [
      'Investment: rental demand in Dubai Marina and Dubai Hills',
      'Family: townhouses with gardens in Creekside Gardens',
      'First home: studios and 1 bedrooms with a payment plan'
    ],
    budgets: ['around 1M', '1.5 to 2M', 'up to 2.5M', 'about 3.5M'],
    firstNames: ['Omar', 'Fatima', 'Rahul', 'Aisha', 'Yousef', 'Priya', 'Hassan', 'Mariam', 'Arjun', 'Layla', 'Ravi', 'Noura', 'Sameer', 'Huda', 'Vikram', 'Sara', 'Khalid', 'Anjali', 'Tariq', 'Reem'],
    lastNames: ['Al Nuaimi', 'Haddad', 'Menon', 'Saleh', 'Kapoor', 'Rahman', 'Pillai', 'Farouk', 'Iyer', 'Mansour', 'Shetty', 'Qasim'],
    handoffSummary: interest => `Wants a site visit: ${interest}`,
    staffReply: 'Hi, this is your property advisor. Sharing the brochure and price list now.',
    followUps: { noAnswer: 'Call again (no answer)', visit: 'Did they come for the site visit?' },
    staff: { manager: ['Lina', 'Hamdan'], sales: [['Karan', 'Desai'], ['Dana', 'Khoury'], ['Imran', 'Sheikh'], ['Meera', 'Nair']] },
    ads: [
      { platform: 'instagram', id: '120240001', headline: '2BR in Dubai Hills from AED 1.8M' },
      { platform: 'facebook', id: '120240002', headline: 'Marina Vista: 60/40 payment plan' },
      { platform: 'instagram', id: '120240003', headline: 'Townhouses with gardens, Creek Harbour' }
    ],
    // Lead lines by language. {p} = project, {u} = unit, {b} = budget.
    opener: {
      en: ['Hi, I saw your ad for {p}. Is the {u} still available?', 'What is the price of a {u} in {p}?', 'Hello, do you have a payment plan for {p}?'],
      ar: ['مرحبا، كم سعر {u} في {p}؟', 'السلام عليكم، هل يوجد خطة دفع في {p}؟'],
      hi: ['{p} mein {u} ka price kya hai?', 'Hi, {u} ke liye payment plan hai kya?']
    },
    budgetLine: { en: 'Budget is {b}, mostly for investment.', ar: 'ميزانيتي {b} تقريبا', hi: 'Budget {b} ke around hai, family ke liye.' },
    visitLine: { en: 'Can I see it this Saturday?', ar: 'هل ممكن أزور المشروع يوم السبت؟', hi: 'Saturday ko site visit ho sakta hai?' },
    laterLine: { en: 'Please call me after 6 PM.', ar: 'اتصل بي بعد الساعة ٦ من فضلك', hi: 'Shaam 6 ke baad call kar dena.' },
    botPrice: {
      en: '{u} in {p} starts at {price}. What budget do you have in mind?',
      ar: 'يبدأ سعر {u} في {p} من {price}. ما هي ميزانيتك؟',
      hi: '{p} mein {u} {price} se start hota hai. Aapka budget kitna hai?'
    },
    botVisit: {
      en: 'Saturday works. Our property advisor will message you shortly to fix the time.',
      ar: 'السبت مناسب. سيتواصل معك مستشارنا العقاري قريبا لتأكيد الموعد.',
      hi: 'Saturday theek hai. Humare property advisor aapko jaldi message karke time fix karenge.'
    },
    langs: ['en', 'en', 'ar', 'hi']
  },
  in: {
    currency: 'INR',
    // +91 98000 xxxxx (12 digits): test range.
    phone: n => `9198000${String(10000 + n).slice(-5)}`,
    area: 'Bengaluru',
    address: '3rd Floor, Demo Square, Outer Ring Road, Bengaluru (sample address)',
    projects: [
      { name: 'Green Meadows', area: 'Sarjapur Road' },
      { name: 'Lakeview Heights', area: 'Hebbal' },
      { name: 'Orchid Villas', area: 'Devanahalli' }
    ],
    units: [
      { name: '2 BHK', price: '₹85L onwards', from: 8500000, to: 10500000, details: '1,150 sq ft, clubhouse' },
      { name: '3 BHK', price: '₹1.35Cr onwards', from: 13500000, to: 16500000, details: '1,650 sq ft, east facing options' },
      { name: '4 BHK Villa', price: '₹2.4Cr onwards', from: 24000000, to: 29000000, details: 'Private garden, 2 car parks' }
    ],
    policies: [
      { name: 'Booking', text: 'A unit is blocked with a 10% booking amount. The advisor shares the payment schedule.' },
      { name: 'Home loan', text: 'Our advisor can connect you with partner banks. Approval depends on the bank.' },
      { name: 'Site visits', text: 'Site visits every day 10 AM to 6 PM. The advisor confirms the slot.' },
      { name: 'Possession', text: 'Possession dates are shared by the advisor for each tower.' }
    ],
    sellingPoints: [
      'IT professionals: Sarjapur Road is close to the tech parks',
      'Families: villas with gardens in Orchid Villas',
      'First home: 2 BHK with home loan support'
    ],
    budgets: ['around 90L', '1 to 1.2Cr', 'up to 1.5Cr', 'about 2.5Cr'],
    firstNames: ['Rahul', 'Sneha', 'Arjun', 'Kavya', 'Vikram', 'Ananya', 'Suresh', 'Divya', 'Karthik', 'Pooja', 'Naveen', 'Meghana', 'Rohit', 'Shruti', 'Aditya', 'Lakshmi'],
    lastNames: ['Sharma', 'Rao', 'Reddy', 'Iyer', 'Gowda', 'Nair', 'Kulkarni', 'Hegde', 'Menon', 'Shetty', 'Joshi', 'Patil'],
    handoffSummary: interest => `Wants a site visit: ${interest}`,
    staffReply: 'Hi, this is your property advisor. Sharing the brochure and price list now.',
    followUps: { noAnswer: 'Call again (no answer)', visit: 'Did they come for the site visit?' },
    staff: { manager: ['Ramesh', 'Kamath'], sales: [['Nisha', 'Bhat'], ['Varun', 'Pai'], ['Deepak', 'Murthy'], ['Asha', 'Prabhu']] },
    ads: [
      { platform: 'instagram', id: '120240101', headline: '2 BHK on Sarjapur Road from ₹85L' },
      { platform: 'facebook', id: '120240102', headline: 'Lakeview Heights: book a site visit' },
      { platform: 'instagram', id: '120240103', headline: 'Orchid Villas: 4 BHK with garden' }
    ],
    opener: {
      en: ['Hi, I saw your ad for {p}. Is the {u} available?', 'What is the price of a {u} in {p}?', 'Hello, is {p} ready to move or under construction?'],
      hi: ['{p} mein {u} ka price kya hai?', 'Hi, {u} ke liye home loan milega kya?', '{p} ka site visit kab ho sakta hai?']
    },
    budgetLine: { en: 'My budget is {b} and I need a home loan.', hi: 'Budget {b} ke around hai, loan lena hai.' },
    visitLine: { en: 'Can I come for a site visit this Sunday?', hi: 'Sunday ko site visit ho sakta hai?' },
    laterLine: { en: 'Please call me after 7 PM.', hi: 'Shaam 7 ke baad call karna please.' },
    botPrice: {
      en: '{u} in {p} starts at {price}. What budget do you have in mind, and do you need a home loan?',
      hi: '{p} mein {u} {price} se start hota hai. Budget kitna hai, aur home loan chahiye?'
    },
    botVisit: {
      en: 'Sunday works. Our property advisor will message you shortly to fix the slot.',
      hi: 'Sunday theek hai. Humare property advisor aapko jaldi message karke slot fix karenge.'
    },
    langs: ['en', 'en', 'hi']
  }
};

/** The business profile for a demo client (keeps the client's own name). */
function profile(name, region) {
  const r = REGIONS[region];
  return {
    name,
    type: 'realestate',
    area: r.area,
    address: r.address,
    parking: 'Visitor parking at every project',
    facility: `Developer and sales team for new homes in ${r.area}`,
    latitude: null,
    longitude: null,
    voice: 'Warm, clear and to the point, like a good property advisor texting a client. Simple English, or the lead\'s language.',
    hours: ['Every day 10:00 AM - 7:00 PM'],
    programs: r.projects.map(p => `${p.name}, ${p.area}`),
    plans: r.units.map(u => ({ name: u.name, price: u.price, details: u.details })),
    policies: r.policies,
    sellingPoints: r.sellingPoints,
    fallback: {
      systemError: `Thanks for messaging ${name}! Our property advisor will get back to you shortly.`,
      nonTextMessage: 'Got it, thanks! Just type your question here and we will help you.'
    }
  };
}

module.exports = { REGIONS, profile };
