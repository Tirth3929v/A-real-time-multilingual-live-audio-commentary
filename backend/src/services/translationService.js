// Using global fetch (available in Node.js 18+)
async function translateCommentary(spanishText, targetLanguage = 'Hindi') {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
        // OpenRouter requires these headers for tracking ranking/analytics
        "HTTP-Referer": "https://stadiumvoice.vercel.app", 
        "X-Title": "StadiumVoice FIFA App",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        // Using a fast, free Llama model optimal for real-time hackathon apps
        "model": "meta-llama/llama-3.3-70b-instruct:free",
        "messages": [
          {
            "role": "system",
            "content": `You are a real-time FIFA World Cup commentary translator. Translate the incoming text into ${targetLanguage}. Keep the energetic tone of a football commentator. Do not change football acronyms like VAR, offside, or foul unless necessary for understanding.`
          },
          {
            "role": "user",
            "content": spanishText
          }
        ],
        "temperature": 0.3 // Kept low so the translation stays accurate and literal
      })
    });

    const data = await response.json();
    
    if (data.choices && data.choices[0]) {
      return data.choices[0].message.content.trim();
    } else {
      throw new Error("Invalid response from OpenRouter");
    }
  } catch (error) {
    console.error("OpenRouter Translation Error:", error);
    return spanishText; // Fallback to raw text if translation breaks
  }
}

module.exports = {
  translateCommentary
};
