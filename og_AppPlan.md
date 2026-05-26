# AppPlan

Fill this in before asking Cowork/Codex to build the app. This file is your direct instruction to Cowork/Codex: it explains what to build, who it is for, what it should take as input, what it should return, how the system prompt should guide the model, and how the app should look. For each item below, write at least a couple full sentences. The more context you provide the more control you will have over the final product.

Replace the text inside square brackets with your own app ideas and preferences.

Before editing code, Cowork/Codex should summarize the app purpose, required layout, colors, inputs, outputs, system prompt requirements, and model behavior from this plan. Treat the app idea and design ideas below as requirements for the first working version.

## App idea

- Use case: [What problem is the app solving?]
- Intended user: [Who is the app for?]
- User input: [What will the user type, upload, or choose?]
- Model output: [What should the model return?]
- System prompt requirements: [If this is an LLM or RAG app, what role should the model play, what rules should it follow, and what format should it return? If this is not an LLM app, write not applicable.]
- Approach: [LLM API, RAG, linear regression, logistic regression, random forest, XGBoost, CNN, MobileNetV2, or something else]
- Important source material or dataset: [Documents, examples, spreadsheet, image dataset, or none]

The first goal is a basic working app. For LLM and RAG apps, Cowork/Codex should create a clearly labeled system prompt in the code that your team can edit later. Once the first version runs locally, iterate with Cowork/Codex to improve the interface, source material, system prompt, examples, and output format.

## Product notes

- App name: [Working name]
- Tone and style: [Professional, playful, clinical, concise, etc.]

## Design ideas

Treat these design choices as requirements, not loose suggestions.

- Colors: [Any preferred colors, brand colors, or colors to avoid]
- Fonts: [Simple, formal, playful, editorial, dashboard-like, etc.]
- Layout: [Single page, sidebar, form plus results panel, chat-style, dashboard, etc.]
- Visual tone: [Minimal, warm, clinical, premium, utilitarian, playful, etc.]

## Notes to Cowork/Codex

If the app requires interactive front-end behavior or machine learning models, use React or FastAPI as necessary. If the app uses an LLM or RAG, make the system prompt explicit in the code instead of burying it inside a long request string.
