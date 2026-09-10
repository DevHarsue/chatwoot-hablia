# Hablia (HAB-1051): on a Channel::Api with hmac_mandatory, every Public API request must prove it holds
# the signature of the source_id it acts on: X-Hablia-Source-Hmac = HMAC-SHA256(hmac_token, source_id).
# Upstream only checks identifier_hash on contacts; conversations and messages trust the source_id alone.
# Unlike identifier_hash, this check never marks hmac_verified, so it does not widen the contact's reach
# to its other inboxes.
module HabliaSourceHmacVerification
  SOURCE_HMAC_HEADER = 'X-Hablia-Source-Hmac'.freeze

  private

  def verify_hablia_source_hmac
    return unless @inbox_channel&.hmac_mandatory

    render_unauthorized('Invalid source signature') unless hablia_source_hmac_valid?
  end

  # A params[:contact_id] other than the signed source_id is rejected too: set_contact_inbox reads it from the
  # merged params, so on contacts routes a query/body contact_id would otherwise probe other source_ids (404/200).
  def hablia_source_hmac_valid?
    source_id = hablia_signed_source_id
    signature = request.headers[SOURCE_HMAC_HEADER]
    return false unless source_id.is_a?(String) && source_id.present? && signature.present?
    return false if params[:contact_id].present? && params[:contact_id] != source_id

    expected = OpenSSL::HMAC.hexdigest('sha256', @inbox_channel.hmac_token, source_id)
    ActiveSupport::SecurityUtils.secure_compare(expected, signature)
  end

  # contacts#process_hmac with hmac_mandatory: the source signature (checked by verify_hablia_source_hmac) is the only
  # credential. identifier_hash is never accepted and a contact can only be read (show), so this API cannot mark
  # hmac_verified nor change a contact's identity.
  def hablia_process_mandatory_hmac
    return if action_name == 'show' && params[:identifier_hash].blank?

    render_unauthorized('Invalid identifier hash')
  end

  # Route segments are read from the path, so a query/body param signed for one's own source_id cannot stand in
  # for someone else's.
  def hablia_signed_source_id
    path = request.path_parameters
    return path[:contact_id] if path.key?(:contact_id) # contacts/:contact_id/conversations/...
    return path[:id] if path.key?(:id) # contacts#show, contacts#update

    params[:source_id] # contacts#create
  end
end
