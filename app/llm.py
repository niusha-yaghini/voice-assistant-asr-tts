"""Answer generation with a small local chat LLM (Qwen2.5-0.5B-Instruct)."""

import logging

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

logger = logging.getLogger(__name__)


class Responder:
    """Wraps a Hugging Face causal LM loaded once and reused for every request."""

    def __init__(self, model_name: str, system_prompt: str, max_new_tokens: int) -> None:
        """Load tokenizer and model on CPU (downloads from Hugging Face on first run)."""
        self._system_prompt = system_prompt
        self._max_new_tokens = max_new_tokens
        self._tokenizer = AutoTokenizer.from_pretrained(model_name)
        self._model = AutoModelForCausalLM.from_pretrained(model_name, dtype=torch.float32)
        self._model.eval()

    def answer(self, question: str) -> str:
        """Return a short answer to ``question`` using the model's chat template."""
        messages = [
            {"role": "system", "content": self._system_prompt},
            {"role": "user", "content": question},
        ]
        inputs = self._tokenizer.apply_chat_template(
            messages,
            add_generation_prompt=True,  # append the "assistant" turn header
            return_tensors="pt",
            return_dict=True,
        )
        with torch.inference_mode():  # no gradients: less memory, faster
            output_ids = self._model.generate(
                **inputs,
                max_new_tokens=self._max_new_tokens,
                do_sample=False,  # deterministic (greedy) output
            )
        # Keep only the newly generated tokens, not the echoed prompt.
        new_tokens = output_ids[0][inputs["input_ids"].shape[1]:]
        text = self._tokenizer.decode(new_tokens, skip_special_tokens=True).strip()
        logger.info("Generated %d tokens", len(new_tokens))
        return text
