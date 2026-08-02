import os
from typing import Annotated

import httpx
from line.llm_agent import LlmAgent, LlmConfig, end_call, loopback_tool
from line.voice_agent_app import VoiceAgentApp


SYSTEM_PROMPT = """You are Badger, a concise automated voice coordinator.
You collect one participant's private scheduling constraints. You never choose the group plan.

After the participant consents:
1. Ask when they are available for the stated goal.
2. Ask for hard constraints or times that absolutely cannot work.
3. For every ambiguous restriction ask: "Is that a hard constraint, or could you be flexible for the right option?"
4. Ask exactly one preference question, such as format or location.
5. Briefly repeat availability, hard vetoes, preferences, and flexibility for confirmation.
6. Only after confirmation, call submit_preferences exactly once.
7. Thank them and call end_call.

Use short questions. Never mention another participant's answers. Never invent an answer.
Normalize time windows to lowercase snake_case labels such as friday_after_8 or saturday_afternoon.
Flexibility is a number from 0 (not flexible) to 1 (very flexible).
If the participant does not consent, apologize and call end_call without submitting preferences.
"""


def required_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def required_metadata(metadata: dict, name: str) -> str:
    value = metadata.get(name)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"Missing call metadata: {name}")
    return value.strip()


async def get_agent(env, call_request):
    metadata = call_request.metadata or {}
    session_id = required_metadata(metadata, "sessionId")
    participant_id = required_metadata(metadata, "participantId")
    participant_name = required_metadata(metadata, "participantName")
    host_name = required_metadata(metadata, "hostName")
    goal = required_metadata(metadata, "goal")
    submitted = False

    @loopback_tool
    async def submit_preferences(
        ctx,
        availability: Annotated[list[str], "Confirmed available time windows in lowercase snake_case"],
        hard_vetoes: Annotated[list[str], "Confirmed times or conditions that absolutely cannot work"],
        preferences: Annotated[list[str], "Soft preferences such as format or location"],
        flexibility: Annotated[float, "Overall flexibility from 0.0 to 1.0"],
        summary: Annotated[str, "One concise sentence summarizing the confirmed response"],
    ):
        """Submit the participant's confirmed scheduling constraints exactly once.

        Call only after repeating the answers and receiving confirmation. Never call when the
        participant declines consent or while any hard-versus-soft constraint is ambiguous.
        """
        nonlocal submitted
        if submitted:
            return "Preferences were already submitted. Thank the participant and end the call."
        if not 0 <= flexibility <= 1:
            return "Flexibility must be between 0 and 1. Confirm it with the participant."

        backend_url = required_env("BADGER_BACKEND_URL").rstrip("/")
        headers = {"Content-Type": "application/json"}
        tool_secret = required_env("BADGER_TOOL_SECRET")
        headers["Authorization"] = f"Bearer {tool_secret}"

        async with httpx.AsyncClient(timeout=8.0) as client:
            response = await client.post(
                f"{backend_url}/internal/preferences",
                headers=headers,
                json={
                    "sessionId": session_id,
                    "participantId": participant_id,
                    "availability": availability,
                    "hardVetoes": hard_vetoes,
                    "preferences": preferences,
                    "flexibility": flexibility,
                    "summary": summary,
                },
            )
            response.raise_for_status()

        submitted = True
        return "Preferences saved. Thank the participant briefly, then end the call."

    introduction = (
        f"Hey {participant_name}, I'm Badger, an automated assistant. "
        f"{host_name} asked me to coordinate {goal}. "
        "This should take about thirty seconds. Is now okay?"
    )
    return LlmAgent(
        model=os.getenv("BADGER_LLM_MODEL", "gpt-5.4"),
        api_key=required_env("OPENAI_API_KEY"),
        tools=[
            submit_preferences,
            end_call(
                description="""End the call only when either the participant declines consent, or
                submit_preferences has succeeded and you have thanked the participant. Do not end
                while an answer is ambiguous or before confirmed preferences are submitted."""
            ),
        ],
        config=LlmConfig(
            system_prompt=SYSTEM_PROMPT,
            introduction=introduction,
            temperature=0.2,
            max_tokens=180,
        ),
    )


app = VoiceAgentApp(get_agent=get_agent)


if __name__ == "__main__":
    app.run()
