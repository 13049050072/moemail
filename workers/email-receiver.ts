import { Env } from '../types'
import PostalMime from 'postal-mime'
import { WEBHOOK_CONFIG } from '../app/config/webhook'
import { EmailMessage } from '../app/lib/webhook'

const handleEmail = async (message: ForwardableEmailMessage, env: Env) => {
  try {
    // 1. 先查邮箱是否存在：不存在直接丢弃，跳过 MIME 解析。
    //    catch-all 下发到不存在地址的垃圾邮件是 CPU 超限的大头——解析一封
    //    HTML 邮件要 10-30ms，而一次查库只要 1-2ms。
    const targetEmail = await env.DB.prepare(
      'SELECT id, userId, address FROM email WHERE LOWER(address) = ? LIMIT 1'
    )
      .bind(message.to.toLowerCase())
      .first<{ id: string; userId: string | null; address: string }>()

    if (!targetEmail) {
      console.error(`Email not found: ${message.to}`)
      return
    }

    // 2. 邮箱存在才解析正文。
    const parsedMessage = await PostalMime.parse(message.raw)

    const now = Date.now()
    const messageId = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO message (id, emailId, from_address, subject, content, html, type, received_at, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, 'received', ?, ?)`
    )
      .bind(
        messageId,
        targetEmail.id,
        message.from,
        parsedMessage.subject || '(无主题)',
        parsedMessage.text || '',
        parsedMessage.html || '',
        now,
        now
      )
      .run()

    const webhook = await env.DB.prepare(
      'SELECT url, enabled FROM webhook WHERE user_id = ? LIMIT 1'
    )
      .bind(targetEmail.userId)
      .first<{ url: string; enabled: number }>()

    if (webhook?.enabled) {
      try {
        await fetch(webhook.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Event': WEBHOOK_CONFIG.EVENTS.NEW_MESSAGE
          },
          body: JSON.stringify({
            emailId: targetEmail.id,
            messageId,
            fromAddress: message.from,
            subject: parsedMessage.subject || '(无主题)',
            content: parsedMessage.text || '',
            html: parsedMessage.html || '',
            receivedAt: new Date(now).toISOString(),
            toAddress: targetEmail.address
          } as EmailMessage)
        })
      } catch (error) {
        console.error('Failed to send webhook:', error)
      }
    }

    console.log(`Email processed: ${parsedMessage.subject}`)
  } catch (error) {
    console.error('Failed to process email:', error)
  }
}

const worker = {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await handleEmail(message, env)
  }
}

export default worker
