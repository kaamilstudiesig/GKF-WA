const axios = require('axios');
const env = require('../config/env');
const gymConfig = require('../config/gymConfig');
const leadRepository = require('../db/leadRepository');

// Tool definitions for OpenAI-compatible function calling
const AI_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'save_lead',
      description: 'Update structured CRM information for the fitness lead when new information is learned during conversation.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Name of the lead'
          },
          interest: {
            type: 'string',
            description: 'Specific interest or goal (e.g. trial, monthly membership, PT, fat loss, CrossFit, yoga)'
          },
          status: {
            type: 'string',
            enum: ['new', 'contacted', 'qualified', 'hot', 'cold', 'converted', 'lost'],
            description: 'Current lead qualification stage'
          },
          notes: {
            type: 'string',
            description: 'Brief qualification notes (experience level, schedule preferences, fitness goals)'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'notify_staff',
      description: 'Trigger human staff handoff when a lead is ready to book, negotiates, asks complex questions, complains, or explicitly requests a human.',
      parameters: {
        type: 'object',
        properties: {
          needs_human: {
            type: 'boolean',
            description: 'Set to true when staff intervention is required'
          },
          handoff_reason: {
            type: 'string',
            enum: [
              'ready_to_book',
              'price_negotiation',
              'custom_program',
              'injury_question',
              'human_requested',
              'complaint',
              'other'
            ],
            description: 'Specific reason for handing off to human gym staff'
          },
          summary: {
            type: 'string',
            description: 'Short note for the staff member on what the lead needs'
          }
        },
        required: ['needs_human', 'handoff_reason']
      }
    }
  }
];

class AIService {
  constructor() {
    this.baseUrl = env.openRouterBaseUrl;
    this.model = env.openRouterModel;
  }

  /**
   * Builds the message array for OpenRouter chat completion
   */
  buildPromptMessages(lead, conversationHistory) {
    const messages = [];

    // System prompt with gym persona & instructions
    messages.push({
      role: 'system',
      content: gymConfig.getSystemPrompt()
    });

    // Current lead CRM state context
    const leadContext = `CURRENT LEAD CRM CONTEXT:
- WhatsApp ID: ${lead.wa_id}
- Known Name: ${lead.display_name || 'Unknown'}
- Current CRM Status: ${lead.status}
- Current Interest: ${lead.interest || 'Not specified'}
- Current Needs Human: ${lead.needs_human ? 'YES (' + lead.handoff_reason + ')' : 'NO'}
- Existing Notes: ${lead.notes || 'None'}`;

    messages.push({
      role: 'system',
      content: leadContext
    });

    // Conversation history bounded to recent messages
    for (const msg of conversationHistory) {
      if (msg.direction === 'in') {
        messages.push({
          role: 'user',
          content: msg.text
        });
      } else if (msg.direction === 'out') {
        messages.push({
          role: 'assistant',
          content: msg.text
        });
      }
    }

    return messages;
  }

  /**
   * Parses fallback delimiter block <<<LEAD_UPDATE: {...}>>> from AI text
   */
  parseDelimitedLeadUpdate(text) {
    if (!text) return { cleanText: text, leadUpdate: null };

    const regex = /<<<LEAD_UPDATE:\s*(\{[\s\S]*?\})\s*>>>/i;
    const match = text.match(regex);

    if (!match) {
      return { cleanText: text.trim(), leadUpdate: null };
    }

    let leadUpdate = null;
    try {
      leadUpdate = JSON.parse(match[1]);
    } catch (err) {
      console.warn('[AI Service] Failed to parse delimited LEAD_UPDATE JSON:', match[1], err.message);
    }

    // Strip the delimited block from human-facing text
    const cleanText = text.replace(regex, '').trim();

    return { cleanText, leadUpdate };
  }

  /**
   * Applies structured extractions to lead record in CRM
   */
  applyLeadUpdates(lead, { name, interest, status, notes, needs_human, handoff_reason, summary }) {
    const updates = {};

    if (name && (!lead.display_name || lead.display_name === 'Unknown')) {
      updates.display_name = name;
    }

    if (interest) {
      updates.interest = interest;
    }

    if (status && ['new', 'contacted', 'qualified', 'hot', 'cold', 'converted', 'lost'].includes(status)) {
      updates.status = status;
    }

    if (needs_human !== undefined) {
      updates.needs_human = Boolean(needs_human);
      if (handoff_reason) {
        updates.handoff_reason = handoff_reason;
      }
    }

    if (summary) {
      updates.notes = lead.notes ? `${lead.notes}\n[Handoff Note]: ${summary}` : `[Handoff Note]: ${summary}`;
    } else if (notes) {
      updates.notes = lead.notes ? `${lead.notes}\n[AI Note]: ${notes}` : `[AI Note]: ${notes}`;
    }

    if (Object.keys(updates).length > 0) {
      console.log(`[CRM Update] Applying updates for lead +${lead.wa_id}:`, JSON.stringify(updates));
      return leadRepository.updateLead(lead.wa_id, updates);
    }

    return lead;
  }

  /**
   * Generates AI reply for inbound message and updates CRM
   */
  async processInboundMessage(lead, incomingText) {
    const conversationHistory = leadRepository.getConversationHistory(lead.wa_id, 20);
    const messages = this.buildPromptMessages(lead, conversationHistory);

    console.log(`[AI Call] Initiating OpenRouter request for lead +${lead.wa_id} with model: ${this.model}`);

    // If API key is not set, simulate response in dev/test
    if (!env.openRouterApiKey || process.env.NODE_ENV === 'test') {
      return this.handleMockAIResponse(lead, incomingText);
    }

    try {
      const response = await axios.post(
        `${this.baseUrl}/chat/completions`,
        {
          model: this.model,
          messages,
          tools: AI_TOOLS,
          tool_choice: 'auto',
          temperature: 0.3,
          max_tokens: 300
        },
        {
          headers: {
            'Authorization': `Bearer ${env.openRouterApiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://goldkraftfitness.com',
            'X-Title': 'Goldkraft WhatsApp AI'
          },
          timeout: 15000
        }
      );

      const choice = response.data?.choices?.[0];
      const message = choice?.message;

      if (!message) {
        throw new Error('Empty or invalid response from OpenRouter API');
      }

      console.log('[AI Call Success] Raw AI Response:', JSON.stringify(message));

      let replyText = message.content || '';
      let extractedUpdates = {};

      // 1. Process Tool/Function Calling if present
      if (message.tool_calls && message.tool_calls.length > 0) {
        for (const toolCall of message.tool_calls) {
          const fnName = toolCall.function?.name;
          let args = {};
          try {
            args = JSON.parse(toolCall.function?.arguments || '{}');
          } catch (e) {
            console.warn('[AI Service] Failed to parse tool arguments:', toolCall.function?.arguments);
          }

          console.log(`[AI Tool Executed] ${fnName}:`, args);

          if (fnName === 'save_lead') {
            extractedUpdates = { ...extractedUpdates, ...args };
          } else if (fnName === 'notify_staff') {
            extractedUpdates = {
              ...extractedUpdates,
              needs_human: args.needs_human !== false,
              handoff_reason: args.handoff_reason || 'human_requested',
              summary: args.summary
            };
          }
        }
      }

      // 2. Process Delimited JSON Fallback if present in replyText
      const { cleanText, leadUpdate } = this.parseDelimitedLeadUpdate(replyText);
      replyText = cleanText;

      if (leadUpdate) {
        extractedUpdates = { ...extractedUpdates, ...leadUpdate };
      }

      // If reply is empty because model only outputted tool call or json, provide default confirmation
      if (!replyText) {
        if (extractedUpdates.needs_human) {
          replyText = "Thanks for letting us know! One of our senior coaches from Goldkraft Fitness will get in touch with you right away to assist.";
        } else {
          replyText = "Got it! How else can we help you crush your training goals at Goldkraft Fitness?";
        }
      }

      // Apply all extractions to the lead record
      this.applyLeadUpdates(lead, extractedUpdates);

      return {
        replyText,
        extractedUpdates
      };
    } catch (error) {
      const status = error.response?.status;
      const errorData = error.response?.data || error.message;

      console.error(`[AI Service Error] Status ${status}:`, JSON.stringify(errorData));

      // Handle 429 (Rate Limit) or 5xx or Timeout gracefully
      // Set needs_human = true and handoff_reason = 'ai_service_unavailable'
      leadRepository.updateLead(lead.wa_id, {
        needs_human: 1,
        handoff_reason: status === 429 ? 'rate_limit_exceeded' : 'ai_service_unavailable'
      });

      return {
        replyText: gymConfig.fallbackMessages.systemError,
        extractedUpdates: {
          needs_human: true,
          handoff_reason: 'ai_service_unavailable'
        }
      };
    }
  }

  /**
   * Deterministic mock processor for tests and local development without API keys
   */
  handleMockAIResponse(lead, incomingText) {
    const textLower = incomingText.toLowerCase();
    let replyText = "Welcome to Goldkraft Fitness! We're located in JP Nagar with 10,000 sq ft of elite functional training equipment. Are you looking for strength training, CrossFit, or personal coaching?";
    let updates = { status: 'contacted' };

    if (textLower.includes('price') || textLower.includes('fee') || textLower.includes('cost') || textLower.includes('membership')) {
      replyText = "Our memberships start at ₹4,040/month for full gym access. We also offer Quarterly Elite (₹7,080/3mo) and Annual Pinnacle (₹14,000/yr) with personal assessment and nutrition guidance. Which plan fits your goals?";
      updates.interest = 'membership_pricing';
      updates.status = 'qualified';
    } else if (textLower.includes('trial') || textLower.includes('book') || textLower.includes('visit') || textLower.includes('join')) {
      replyText = "You can definitely book an introductory trial session! When would you like to come in? (We are open Mon-Sat 5 AM - 10 PM, Sun 8 AM - 2 PM).";
      updates.interest = 'trial_booking';
      updates.status = 'hot';
      updates.needs_human = true;
      updates.handoff_reason = 'ready_to_book';
    } else if (textLower.includes('discount') || textLower.includes('cheap') || textLower.includes('negotiate')) {
      replyText = "Our pricing reflects our premier facility and coaching standards. Let me have our manager connect with you regarding current seasonal promotions.";
      updates.needs_human = true;
      updates.handoff_reason = 'price_negotiation';
    } else if (textLower.includes('human') || textLower.includes('speak') || textLower.includes('call') || textLower.includes('coach')) {
      replyText = "Absolutely! I have alerted our coaching team. A staff member from Goldkraft Fitness will message or call you shortly.";
      updates.needs_human = true;
      updates.handoff_reason = 'human_requested';
    }

    this.applyLeadUpdates(lead, updates);

    return {
      replyText,
      extractedUpdates: updates
    };
  }
}

module.exports = new AIService();
module.exports.AIService = AIService;
