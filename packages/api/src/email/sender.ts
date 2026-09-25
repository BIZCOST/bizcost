import type { Transporter } from 'nodemailer'
import type { EmailConfig } from '../deps'
import { AppError } from '../errors'

// The API's own emails (invitations; docs/ARCHITECTURE.md §Auth). Auth codes are sent by Supabase
// Auth, not here. The transport comes from the environment: SMTP (locally the Supabase stack's
// Mailpit) or the Resend HTTP API (production). Bodies, links and tokens are never logged: a failure
// carries only the transport's error name and code.

export interface EmailMessage {
  readonly to: string
  readonly subject: string
  readonly html: string
  readonly text: string
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>
}

/**
 * How long one send may take in all before it fails. Emails are sent outside any database transaction,
 * but the request still waits for them.
 */
const SEND_TIMEOUT_MS = 10_000

/** Fails with a TimeoutError when `work` takes longer than `ms` (the work itself is abandoned). */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error('email send timed out'), { name: 'TimeoutError' }))
    }, ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

/** An internal error that says which transport failed, without any message content. */
function sendFailed(transport: string, error: unknown): AppError {
  const summary =
    error && typeof error === 'object'
      ? {
          name: 'name' in error ? String(error.name) : 'Error',
          code: 'code' in error ? String(error.code) : undefined,
          status: 'status' in error ? Number(error.status) : undefined,
        }
      : { name: typeof error }
  return new AppError('internal', {
    message: `email could not be sent (${transport})`,
    cause: summary,
  })
}

function smtpSender(config: Extract<EmailConfig, { transport: 'smtp' }>): EmailSender {
  let transporter: Promise<Transporter> | undefined
  const load = async () => {
    const nodemailer = await import('nodemailer')
    return nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: false,
      // Local Mailpit speaks plain SMTP without authentication.
      ignoreTLS: true,
      connectionTimeout: SEND_TIMEOUT_MS,
      greetingTimeout: SEND_TIMEOUT_MS,
      socketTimeout: SEND_TIMEOUT_MS,
      logger: false,
      debug: false,
    })
  }
  return {
    async send(message) {
      try {
        transporter ??= load()
        const smtp = await transporter
        // Each SMTP phase has its own timeout; this bounds the whole send.
        await withTimeout(
          smtp.sendMail({
            from: config.from,
            to: message.to,
            subject: message.subject,
            html: message.html,
            text: message.text,
          }),
          SEND_TIMEOUT_MS,
        )
      } catch (error) {
        throw sendFailed('smtp', error)
      }
    },
  }
}

function resendSender(config: Extract<EmailConfig, { transport: 'resend' }>): EmailSender {
  return {
    async send(message) {
      let response: Response
      try {
        response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from: config.from,
            to: [message.to],
            subject: message.subject,
            html: message.html,
            text: message.text,
          }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        })
      } catch (error) {
        throw sendFailed('resend', error)
      }
      // The response body is not read into the error: it may echo the message.
      if (!response.ok) throw sendFailed('resend', { name: 'HttpError', status: response.status })
    },
  }
}

/** Without a configured transport every send fails with an internal error (and changes nothing). */
const NOT_CONFIGURED: EmailSender = {
  send() {
    return Promise.reject(
      new AppError('internal', {
        message: 'no email transport: set EMAIL_TRANSPORT=smtp or RESEND_API_KEY',
      }),
    )
  },
}

const senders = new WeakMap<EmailConfig, EmailSender>()

/** The sender for a configuration (one per configuration object, so SMTP connections are reused). */
export function emailSenderFor(config: EmailConfig | undefined): EmailSender {
  if (!config) return NOT_CONFIGURED
  let sender = senders.get(config)
  if (!sender) {
    sender = config.transport === 'smtp' ? smtpSender(config) : resendSender(config)
    senders.set(config, sender)
  }
  return sender
}
