/**
 * GENERATED FILE — DO NOT EDIT.
 * Regenerate with scripts/generate-model-capability-catalog.ts.
 * models.dev repository license: MIT. The API payload does not attest the
 * separately observed source revision; both identities are recorded below.
 */

export const MODELS_DEV_UPSTREAM_LICENSE_NOTICE = "MIT License\n\nCopyright (c) 2025 models.dev\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the \"Software\"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE." as const

export const MODELS_DEV_CATALOG_PROVENANCE = {
  "schemaVersion": 1,
  "sourceUrl": "https://models.dev/api.json",
  "sourceRepository": "https://github.com/anomalyco/models.dev",
  "sourceRevision": "c2b10ec21b6ac2c856b74a08d872af5a54833954",
  "sourceRevisionAttestedByApi": false,
  "sourcePayloadSha256": "0e9a324d88b32ad6e14075997b9f1a0f71e367be0bebfb25b8404701ca03bd1f",
  "generatedAt": "2026-11-25T22:30:58.000Z",
  "generatorVersion": 1,
  "license": "MIT",
  "licenseUrl": "https://github.com/anomalyco/models.dev/blob/c2b10ec21b6ac2c856b74a08d872af5a54833954/LICENSE",
  "catalogSha256": "504abb06a14a15a129e0d6ed4a710d15e44bfda95b3e519208a78bfc6661c5dd"
} as const

export const MODELS_DEV_CAPABILITY_CATALOG = {
  "anthropic": {
    "claude-haiku-4-5": {
      "contextWindowTokens": 200000,
      "outputTokens": 64000,
      "reasoning": true,
      "canonicalModelId": "anthropic/claude-haiku-4-5",
      "sourceLastUpdated": "2025-10-15",
      "pricing": {
        "inputPerMillionTokens": 1,
        "outputPerMillionTokens": 5,
        "cachedInputPerMillionTokens": 0.1,
        "cacheWriteInputPerMillionTokens": 1.25,
        "currency": "USD"
      }
    },
    "claude-opus-4-5": {
      "contextWindowTokens": 200000,
      "outputTokens": 64000,
      "reasoning": true,
      "canonicalModelId": "anthropic/claude-opus-4-5",
      "sourceLastUpdated": "2025-11-24",
      "pricing": {
        "inputPerMillionTokens": 5,
        "outputPerMillionTokens": 25,
        "cachedInputPerMillionTokens": 0.5,
        "cacheWriteInputPerMillionTokens": 6.25,
        "currency": "USD"
      }
    },
    "claude-sonnet-4-5": {
      "contextWindowTokens": 200000,
      "outputTokens": 64000,
      "reasoning": true,
      "canonicalModelId": "anthropic/claude-sonnet-4-5",
      "sourceLastUpdated": "2025-09-29",
      "pricing": {
        "inputPerMillionTokens": 3,
        "outputPerMillionTokens": 15,
        "cachedInputPerMillionTokens": 0.3,
        "cacheWriteInputPerMillionTokens": 3.75,
        "currency": "USD"
      }
    },
    "claude-sonnet-5-5": {
      "contextWindowTokens": 1000000,
      "outputTokens": 128000,
      "reasoning": true,
      "canonicalModelId": "anthropic/claude-sonnet-5-5",
      "sourceLastUpdated": "2026-09-28",
      "pricing": {
        "inputPerMillionTokens": 2,
        "outputPerMillionTokens": 10,
        "cachedInputPerMillionTokens": 0.1,
        "cacheWriteInputPerMillionTokens": 2.5,
        "currency": "USD"
      }
    }
  },
  "openai": {
    "gpt-4.1": {
      "contextWindowTokens": 1047576,
      "outputTokens": 32768,
      "reasoning": false,
      "sourceLastUpdated": "2025-04-14",
      "pricing": {
        "inputPerMillionTokens": 2,
        "outputPerMillionTokens": 8,
        "cachedInputPerMillionTokens": 0.5,
        "currency": "USD"
      }
    },
    "gpt-4.1-mini": {
      "contextWindowTokens": 1047576,
      "outputTokens": 32768,
      "reasoning": false,
      "sourceLastUpdated": "2025-04-14",
      "pricing": {
        "inputPerMillionTokens": 0.4,
        "outputPerMillionTokens": 1.6,
        "cachedInputPerMillionTokens": 0.1,
        "currency": "USD"
      }
    },
    "gpt-5.1": {
      "contextWindowTokens": 400000,
      "outputTokens": 128000,
      "reasoning": true,
      "sourceLastUpdated": "2025-11-13",
      "pricing": {
        "inputPerMillionTokens": 1.25,
        "outputPerMillionTokens": 10,
        "cachedInputPerMillionTokens": 0.125,
        "currency": "USD"
      }
    },
    "gpt-5.2": {
      "contextWindowTokens": 400000,
      "outputTokens": 128000,
      "reasoning": true,
      "sourceLastUpdated": "2025-12-11",
      "pricing": {
        "inputPerMillionTokens": 1.75,
        "outputPerMillionTokens": 14,
        "cachedInputPerMillionTokens": 0.175,
        "currency": "USD"
      }
    },
    "gpt-5.4": {
      "contextWindowTokens": 1050000,
      "outputTokens": 128000,
      "reasoning": true,
      "sourceLastUpdated": "2026-03-05",
      "pricingOmittedReason": "conditional-tiers"
    },
    "gpt-5.4-mini": {
      "contextWindowTokens": 400000,
      "outputTokens": 128000,
      "reasoning": true,
      "sourceLastUpdated": "2026-03-17",
      "pricing": {
        "inputPerMillionTokens": 0.75,
        "outputPerMillionTokens": 4.5,
        "cachedInputPerMillionTokens": 0.075,
        "currency": "USD"
      }
    },
    "gpt-5.4-nano": {
      "contextWindowTokens": 400000,
      "outputTokens": 128000,
      "reasoning": true,
      "sourceLastUpdated": "2026-03-17",
      "pricing": {
        "inputPerMillionTokens": 0.2,
        "outputPerMillionTokens": 1.25,
        "cachedInputPerMillionTokens": 0.02,
        "currency": "USD"
      }
    },
    "gpt-5.5": {
      "contextWindowTokens": 1050000,
      "outputTokens": 128000,
      "reasoning": true,
      "sourceLastUpdated": "2026-04-23",
      "pricingOmittedReason": "conditional-tiers"
    },
    "gpt-6.2-sol": {
      "contextWindowTokens": 1050000,
      "outputTokens": 128000,
      "reasoning": true,
      "canonicalModelId": "openai/gpt-6.2-sol",
      "sourceLastUpdated": "2026-11-17",
      "pricingOmittedReason": "conditional-tiers"
    }
  },
  "openrouter": {
    "anthropic/claude-opus-4.1": {
      "contextWindowTokens": 200000,
      "outputTokens": 32000,
      "reasoning": true,
      "canonicalModelId": "anthropic/claude-opus-4-1",
      "sourceLastUpdated": "2025-08-05",
      "pricing": {
        "inputPerMillionTokens": 15,
        "outputPerMillionTokens": 75,
        "cachedInputPerMillionTokens": 1.5,
        "cacheWriteInputPerMillionTokens": 18.75,
        "currency": "USD"
      }
    },
    "anthropic/claude-sonnet-4.5": {
      "contextWindowTokens": 1000000,
      "outputTokens": 64000,
      "reasoning": true,
      "canonicalModelId": "anthropic/claude-sonnet-4-5",
      "sourceLastUpdated": "2025-09-29",
      "pricingOmittedReason": "conditional-tiers"
    },
    "anthropic/claude-sonnet-5.5": {
      "contextWindowTokens": 1000000,
      "outputTokens": 128000,
      "reasoning": true,
      "canonicalModelId": "anthropic/claude-sonnet-5-5",
      "sourceLastUpdated": "2026-09-28",
      "pricing": {
        "inputPerMillionTokens": 2,
        "outputPerMillionTokens": 10,
        "cachedInputPerMillionTokens": 0.1,
        "cacheWriteInputPerMillionTokens": 2.5,
        "currency": "USD"
      }
    },
    "openai/gpt-4.1-mini": {
      "contextWindowTokens": 1047576,
      "outputTokens": 32768,
      "reasoning": false,
      "canonicalModelId": "openai/gpt-4.1-mini",
      "sourceLastUpdated": "2025-04-14",
      "pricing": {
        "inputPerMillionTokens": 0.4,
        "outputPerMillionTokens": 1.6,
        "cachedInputPerMillionTokens": 0.1,
        "currency": "USD"
      }
    },
    "openai/gpt-6.2-sol": {
      "contextWindowTokens": 1050000,
      "outputTokens": 128000,
      "reasoning": true,
      "canonicalModelId": "openai/gpt-6.2-sol",
      "sourceLastUpdated": "2026-11-17",
      "pricingOmittedReason": "conditional-tiers"
    }
  }
} as const
