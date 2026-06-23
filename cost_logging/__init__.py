"""Vera local cost-logging package.

Captures provider-only usage (OpenAI, Fish/BMO TTS, Serper) per request and per
session. Does NOT include RunPod or any server-hosting cost.

Public surface (re-exported from :mod:`cost_logging.logger`)::

    from cost_logging import (
        init_cost_logging,
        begin_session, end_session, set_scenario,
        request_context, begin_request, end_request,
        set_session_id, update_request,
        log_openai_event, log_fish_event, log_serper_event,
    )

OpenAI clients are auto-instrumented by calling
``cost_logging.instrument_openai_client(client)``.
"""

from .credits import (  # noqa: F401
    DEFAULT_CREDIT_CONFIG,
    classify_credit_action,
    compute_credits,
    credit_action_keys,
    credit_config_source,
    load_credit_config,
    reload_credit_config,
)
from .logger import (  # noqa: F401
    LOG_DIR,
    begin_request,
    begin_session,
    compute_live_session_totals,
    end_request,
    end_session,
    finalize_request_cost,
    init_cost_logging,
    list_open_session_ids,
    log_fish_event,
    log_openai_event,
    log_serper_event,
    request_context,
    set_scenario,
    set_session_id,
    update_request,
)
from .log_admin import (  # noqa: F401
    RECOMMENDED_SCENARIO_NAMES,
    archive_cost_logs,
    cost_log_reset_allowed,
    get_cost_logs_status,
    reset_cost_logs,
)
from .openai_instrumentation import instrument_openai_client  # noqa: F401
from .pricing import (  # noqa: F401
    get_fish_price,
    get_openai_price,
    get_serper_price,
    load_pricing,
    reload_pricing,
)
