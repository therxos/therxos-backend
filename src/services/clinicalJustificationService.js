/**
 * Clinical Justification Service
 * Uses DeepSeek AI to generate clinical justifications for therapeutic interchanges
 */

import OpenAI from 'openai';

// Initialize DeepSeek client (OpenAI-compatible API)
const deepseek = process.env.DEEPSEEK_API_KEY ? new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com'
}) : null;

/**
 * Generate a clinical justification for a therapeutic interchange trigger
 * @param {Object} trigger - The trigger object with detection keywords and recommended drug
 * @returns {Promise<string>} - The generated clinical justification
 */
export async function generateClinicalJustification(trigger) {
  if (!deepseek) {
    throw new Error('DeepSeek API not configured. Please set DEEPSEEK_API_KEY environment variable.');
  }

  const {
    display_name,
    trigger_type,
    detection_keywords,
    recommended_drug,
    category
  } = trigger;

  // Build context about what's being switched
  const currentDrugs = Array.isArray(detection_keywords)
    ? detection_keywords.join(', ')
    : detection_keywords || 'unknown medication';

  const prompt = `You are a clinical pharmacist writing a brief justification for a therapeutic interchange recommendation to send to prescribers.

Trigger: ${display_name}
Type: ${trigger_type || 'therapeutic_interchange'}
Category: ${category || 'General'}
Current Medication(s): ${currentDrugs}
Recommended Alternative: ${recommended_drug}

Write a concise clinical justification (2-3 sentences) for why this therapeutic interchange is beneficial. Focus on:
- Patient benefit (efficacy, safety, tolerability)
- Clinical equivalence or superiority
- Any relevant guidelines or evidence
- Cost savings for the patient when applicable

Keep the tone professional and clinical. Do NOT mention "optimization" or "pharmacy benefit" - focus only on patient care benefits.

Return ONLY the justification text, no headers or formatting.`;

  try {
    const response = await deepseek.chat.completions.create({
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content: 'You are an expert clinical pharmacist who writes clear, evidence-based therapeutic interchange justifications for prescriber communication. Your justifications are concise, professional, and focused on patient outcomes.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      max_tokens: 300,
      temperature: 0.7
    });

    const justification = response.choices[0]?.message?.content?.trim();

    if (!justification) {
      throw new Error('No justification generated');
    }

    return justification;
  } catch (error) {
    console.error('Error generating clinical justification:', error);
    throw error;
  }
}

/**
 * Generate clinical justifications for multiple triggers
 * @param {Array} triggers - Array of trigger objects
 * @param {Function} onProgress - Optional callback for progress updates (index, total, trigger)
 * @returns {Promise<Array>} - Array of results with trigger_id and justification or error
 */
export async function generateJustificationsForTriggers(triggers, onProgress) {
  const results = [];

  for (let i = 0; i < triggers.length; i++) {
    const trigger = triggers[i];

    if (onProgress) {
      onProgress(i + 1, triggers.length, trigger);
    }

    try {
      const justification = await generateClinicalJustification(trigger);
      results.push({
        trigger_id: trigger.trigger_id,
        display_name: trigger.display_name,
        success: true,
        justification
      });

      // Small delay to avoid rate limiting
      if (i < triggers.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch (error) {
      results.push({
        trigger_id: trigger.trigger_id,
        display_name: trigger.display_name,
        success: false,
        error: error.message
      });
    }
  }

  return results;
}

export default {
  generateClinicalJustification,
  generateJustificationsForTriggers
};
