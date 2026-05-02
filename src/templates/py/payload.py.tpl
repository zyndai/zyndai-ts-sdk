"""
Request + response schemas for __AGENT_NAME__.

Edit `RequestPayload` to declare what callers send, and `ResponsePayload`
to declare what they receive. Both JSON Schemas are auto-advertised at
/.well-known/agent-card.json (as `input_schema` and `output_schema`) so
callers can discover the contract without reading your code.

RequestPayload examples (uncomment and adapt):

    from typing import Literal
    from pydantic import Field

    class RequestPayload(AgentPayload):
        name: str
        email: str
        age: int
        gender: Literal["m", "f", "other"]

        # A required PDF upload with mime-type whitelist:
        resume: list[Attachment] = Field(
            default_factory=list,
            min_length=1,
            json_schema_extra={"accepted_mime_types": ["application/pdf"]},
        )

ResponsePayload examples:

    class ResponsePayload(BaseModel):
        status: Literal["ok", "error"]
        user_id: str
        message: str
"""

from pydantic import BaseModel, ConfigDict

from zyndai_agent import AgentPayload, Attachment


class RequestPayload(AgentPayload):
    """Schema for requests to this agent.

    Starts identical to the default AgentPayload so existing callers keep
    working. Add your own fields above the `pass` and they'll show up in
    /.well-known/agent.json automatically.

    File attachments are opt-in: declare a `list[Attachment]` field (any name
    you like) and the agent will advertise `accepts_files: true`. Without
    such a field, file support is not offered.
    """

    pass


class ResponsePayload(BaseModel):
    """Schema for responses this agent sends back.

    Starts with a single `response: str` field — what most agents return.
    Add fields, tighten types, or set `extra="allow"` once your response
    shape is stable — the SDK validates every response against this model
    before shipping it, catching handler bugs with a clear error instead
    of surprising callers.
    """

    model_config = ConfigDict(extra="allow")
    response: str = ""


# Cap on the total A2A request body size. Bounds how big an inline base64
# attachment can come through before Flask rejects with 413. Tune per your
# agent's needs — transcription agents handling audio/video may want 50+ MB;
# a form-filler probably wants 5 MB.
MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024  # 25 MB
