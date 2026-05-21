(function () {
  const posthogEnv = import.meta.env || {};
  const metaKey = document.querySelector('meta[name="posthog-key"]')?.content.trim();
  const metaHost = document.querySelector('meta[name="posthog-host"]')?.content.trim();
  const posthogKey = posthogEnv.VITE_POSTHOG_KEY || metaKey || "";
  const posthogHost = posthogEnv.VITE_POSTHOG_HOST || metaHost || "https://us.i.posthog.com";
  const configuredFormEndpoint = (posthogEnv.VITE_FORM_ENDPOINT || "").trim();
  const configuredFormInbox = (posthogEnv.VITE_FORM_FALLBACK_EMAIL || "").trim();
  let analyticsReady = false;
  let sampleStarted = false;

  function getUtmParams() {
    const params = new URLSearchParams(window.location.search);
    return {
      utm_source: params.get("utm_source") || "",
      utm_medium: params.get("utm_medium") || "",
      utm_campaign: params.get("utm_campaign") || ""
    };
  }

  function fillHiddenUtmFields() {
    const utm = getUtmParams();
    for (const [name, value] of Object.entries(utm)) {
      const field = document.querySelector(`[name="${name}"]`);
      if (field) field.value = value;
    }
  }

  function applyPageFormDefaults() {
    const defaultPlatform = document.body?.dataset.defaultPlatform;
    if (!defaultPlatform) return;

    const platform = document.querySelector('select[name="platform"]');
    if (!platform || platform.value) return;

    const option = Array.from(platform.options).find((item) => item.textContent.trim() === defaultPlatform);
    if (option) {
      platform.value = option.value || option.textContent.trim();
    }
  }

  function allowedFormProperties(form) {
    const data = new FormData(form);
    return {
      platform: data.get("platform") || "",
      dispute_reason: data.get("dispute_reason") || "",
      already_submitted: data.get("already_submitted") || "",
      paid_packet_interest: data.get("paid_packet_interest_optional") || "",
      ...getUtmParams()
    };
  }

  function loadPostHog() {
    if (!posthogKey) return;

    window.posthog =
      window.posthog ||
      function () {
        (window.posthog.q = window.posthog.q || []).push(arguments);
      };

    const script = document.createElement("script");
    script.async = true;
    script.src = `${posthogHost}/static/array.js`;
    script.onload = function () {
      window.posthog.init(posthogKey, {
        api_host: posthogHost,
        autocapture: false,
        capture_pageview: false,
        disable_session_recording: true
      });
      analyticsReady = true;
      if (window.location.pathname.endsWith("thanks.html") || window.location.pathname.endsWith("/thanks")) {
        track("sample_request_confirmed", getUtmParams());
      } else {
        track("landing_viewed", getUtmParams());
      }
    };
    document.head.appendChild(script);
  }

  function track(eventName, properties) {
    if (!analyticsReady || !window.posthog?.capture) return;
    window.posthog.capture(eventName, properties || {});
  }

  function markSampleStarted(form) {
    if (sampleStarted) return;
    sampleStarted = true;
    track("sample_request_started", allowedFormProperties(form));
  }

  function validateLongText(form) {
    const error = form.querySelector(".form-error");
    const timeline = form.elements.namedItem("timeline");
    const evidence = form.elements.namedItem("evidence_available");
    const invalid =
      (timeline && timeline.value.trim().length < 40) ||
      (evidence && evidence.value.trim().length < 40);

    if (!invalid) {
      if (error) {
        error.textContent = "";
        error.hidden = true;
      }
      return true;
    }

    if (error) {
      error.textContent = "Please add at least 40 characters for the timeline and available evidence fields.";
      error.hidden = false;
    }
    return false;
  }

  function getFormEndpoint(form) {
    const inlineEndpoint = form.dataset.formEndpoint || "";
    const actionEndpoint = form.getAttribute("action") || "";
    return configuredFormEndpoint || inlineEndpoint.trim() || actionEndpoint.trim();
  }

  function getFallbackInbox(form) {
    const inlineInbox = form.dataset.formInbox || "";
    return configuredFormInbox || inlineInbox.trim() || "chargebackpacketops@gmail.com";
  }

  function buildEncodedFormBody(form) {
    const formData = new FormData(form);
    const body = new URLSearchParams();
    for (const [key, value] of formData.entries()) {
      body.append(key, String(value));
    }
    return body;
  }

  function buildFallbackMailto(form) {
    const formData = new FormData(form);
    const selected = [
      "platform",
      "dispute_reason",
      "order_value",
      "submission_deadline",
      "timeline",
      "evidence_available",
      "biggest_uncertainty",
      "already_submitted"
    ];
    const lines = [
      "RebutKit sample request fallback",
      "",
      "Please review the redacted case details below:"
    ];

    for (const name of selected) {
      const value = String(formData.get(name) || "").trim();
      if (value) lines.push(`${name}: ${value}`);
    }

    const params = new URLSearchParams({
      subject: "New RebutKit sample request",
      body: lines.join("\n")
    });
    return `mailto:${getFallbackInbox(form)}?${params.toString()}`;
  }

  function setFormError(form, message) {
    const error = form.querySelector(".form-error");
    if (!error) return;

    error.textContent = "";
    const text = document.createElement("span");
    text.textContent = `${message} `;
    const link = document.createElement("a");
    link.href = buildFallbackMailto(form);
    link.textContent = `Email ${getFallbackInbox(form)} instead.`;
    error.append(text, link);
    error.hidden = false;
  }

  function setSubmitting(form, isSubmitting) {
    const button = form.querySelector(".submit-button");
    if (!(button instanceof HTMLButtonElement)) return;

    if (!button.dataset.defaultText) {
      button.dataset.defaultText = button.textContent || "Submit free sample request";
    }

    button.disabled = isSubmitting;
    button.textContent = isSubmitting ? "Submitting..." : button.dataset.defaultText;
  }

  async function confirmsReceipt(response) {
    if (!response.ok) return false;

    const responseType = response.headers.get("content-type") || "";
    if (!responseType.includes("application/json")) return true;

    const payload = await response.clone().json().catch(() => null);
    if (!payload || typeof payload !== "object") return true;

    if (payload.success === false || payload.success === "false") return false;
    if (payload.error) return false;
    return true;
  }

  function bindInteractions() {
    const form = document.querySelector('form[name="sample-request-v2"]');
    if (!form) return;

    document.querySelectorAll("[data-track-start]").forEach((element) => {
      element.addEventListener("click", () => markSampleStarted(form));
    });

    form.addEventListener("focusin", (event) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.name && target.name !== "email") {
        markSampleStarted(form);
      }
    });

    form.addEventListener("submit", async (event) => {
      if (!validateLongText(form)) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      track("sample_request_submitted", allowedFormProperties(form));
      setSubmitting(form, true);

      try {
        const response = await fetch(getFormEndpoint(form), {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded"
          },
          body: buildEncodedFormBody(form).toString()
        });

        if (!(await confirmsReceipt(response))) {
          setFormError(form, "The online form did not confirm receipt.");
          setSubmitting(form, false);
          return;
        }
      } catch (_error) {
        setFormError(form, "The online form could not connect.");
        setSubmitting(form, false);
        return;
      }

      window.location.href = "/thanks.html";
    });

    document.querySelectorAll("[data-pricing-interest]").forEach((button) => {
      button.addEventListener("click", () => {
        track("pricing_interest_clicked", {
          paid_packet_interest: button.getAttribute("data-pricing-interest") || "",
          ...getUtmParams()
        });
      });
    });

    const optionalDetails = form.querySelector("details.optional-fields");
    if (optionalDetails) {
      optionalDetails.addEventListener("toggle", () => {
        if (optionalDetails.open) {
          track("optional_context_opened", getUtmParams());
        }
      });
    }

    document.querySelectorAll(".faq-list details").forEach((details, index) => {
      details.addEventListener("toggle", () => {
        if (details.open) {
          track("faq_opened", {
            faq_index: String(index + 1),
            ...getUtmParams()
          });
        }
      });
    });
  }

  function bindFooterDialogs() {
    document.querySelectorAll("[data-modal-target]").forEach((button) => {
      button.addEventListener("click", () => {
        const dialogId = button.getAttribute("data-modal-target");
        const dialog = dialogId ? document.getElementById(dialogId) : null;
        if (!(dialog instanceof HTMLElement)) return;

        const canShowModal =
          typeof HTMLDialogElement !== "undefined" &&
          dialog instanceof HTMLDialogElement &&
          typeof dialog.showModal === "function";

        if (canShowModal) {
          dialog.showModal();
        } else {
          dialog.setAttribute("open", "");
        }
      });
    });

    document.querySelectorAll(".policy-dialog").forEach((dialog) => {
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog && typeof dialog.close === "function") {
          dialog.close();
        }
      });

      dialog.querySelectorAll("[data-modal-close]").forEach((button) => {
        button.addEventListener("click", () => {
          if (typeof dialog.close === "function") {
            dialog.close();
          } else {
            dialog.removeAttribute("open");
          }
        });
      });
    });
  }

  fillHiddenUtmFields();
  applyPageFormDefaults();
  bindFooterDialogs();
  bindInteractions();
  loadPostHog();
  if (!posthogKey) {
    analyticsReady = false;
  }
})();
