class HabliaWebhookService
  WEBHOOK_URL_ENV = 'HABLIA_WEBHOOK_URL'.freeze

  def self.deliver(event, payload = {})
    webhook_url = ENV.fetch(WEBHOOK_URL_ENV, nil)
    return if webhook_url.blank?

    data = {
      event: event,
      timestamp: Time.current.iso8601
    }.merge(payload)

    WebhookJob.perform_later(webhook_url, data)
  end
end
