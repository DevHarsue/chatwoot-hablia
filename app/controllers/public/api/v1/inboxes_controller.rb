class Public::Api::V1::InboxesController < PublicController
  include HabliaSourceHmacVerification

  before_action :set_inbox_channel
  before_action :verify_hablia_source_hmac # Hablia (HAB-1051): before any contact_inbox lookup
  before_action :set_contact_inbox
  before_action :set_conversation

  def show
    @inbox_channel = ::Channel::Api.find_by!(identifier: params[:id])
  end

  private

  def set_inbox_channel
    return if params[:inbox_id].blank?

    @inbox_channel = ::Channel::Api.find_by!(identifier: params[:inbox_id])
  end

  def set_contact_inbox
    return if params[:contact_id].blank?

    @contact_inbox = @inbox_channel.inbox.contact_inboxes.find_by!(source_id: params[:contact_id])
  end

  def set_conversation
    return if params[:conversation_id].blank?

    # Hablia (HAB-1051): scoped like ConversationsController#set_conversation. contact.conversations reached
    # the contact's conversations in other inboxes (e.g. WhatsApp) by display_id.
    conversations = @contact_inbox.hmac_verified? ? @contact_inbox.contact.conversations : @contact_inbox.conversations
    @conversation = conversations.find_by!(display_id: params[:conversation_id])
  end
end
