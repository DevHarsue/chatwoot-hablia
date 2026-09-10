require 'rails_helper'

# Hablia (HAB-1051): X-Hablia-Source-Hmac on the Public API of API inboxes with hmac_mandatory.
RSpec.describe 'Public Inbox API source signature', type: :request do
  let(:account) { create(:account) }
  let(:api_channel) { create(:channel_api, account: account, hmac_mandatory: true) }
  let(:inbox_path) { "/public/api/v1/inboxes/#{api_channel.identifier}" }
  let(:contact) { create(:contact, account: account, phone_number: '+525550000001') }
  let!(:contact_inbox) { create(:contact_inbox, contact: contact, inbox: api_channel.inbox, source_id: '+525550000001') }
  let!(:conversation) { create(:conversation, account: account, inbox: api_channel.inbox, contact: contact, contact_inbox: contact_inbox) }
  let(:contact_path) { contact_path_for(contact_inbox.source_id) }
  let(:owner_headers) { signed_headers(contact_inbox.source_id) }
  let(:whatsapp_conversation) do
    whatsapp_channel = create(:channel_whatsapp, account: account, sync_templates: false, validate_provider_config: false)
    create(:conversation, account: account, inbox: whatsapp_channel.inbox, contact: contact)
  end

  def contact_path_for(source_id)
    "#{inbox_path}/contacts/#{ERB::Util.url_encode(source_id)}"
  end

  def signed_headers(source_id)
    { 'X-Hablia-Source-Hmac' => OpenSSL::HMAC.hexdigest('sha256', api_channel.hmac_token, source_id) }
  end

  describe 'with hmac_mandatory' do
    it 'keeps serving the inbox details without the signature header' do
      get inbox_path

      expect(response).to have_http_status(:success)
      expect(response.parsed_body['identifier']).to eq(api_channel.identifier)
    end

    context 'with a valid signature for the source_id' do
      it 'serves the conversations and messages of the contact_inbox' do
        get "#{contact_path}/conversations", headers: owner_headers

        expect(response).to have_http_status(:success)
        expect(response.parsed_body.pluck('uuid')).to eq([conversation.uuid])

        post "#{contact_path}/conversations/#{conversation.display_id}/messages", params: { content: 'hola' }, headers: owner_headers

        expect(response).to have_http_status(:success)
        expect(conversation.messages.last.content).to eq('hola')
      end

      it 'returns the contact without marking it hmac_verified' do
        get contact_path, headers: owner_headers

        expect(response).to have_http_status(:success)
        expect(response.parsed_body['pubsub_token']).to eq(contact_inbox.pubsub_token)
        expect(contact_inbox.reload.hmac_verified).to be(false)
      end
    end

    context 'without the signature header' do
      it 'rejects every contact scoped request with 401' do
        message = create(:message, account: account, inbox: api_channel.inbox, conversation: conversation)
        conversation_path = "#{contact_path}/conversations/#{conversation.display_id}"
        requests = [
          [:get, contact_path], [:patch, contact_path],
          [:get, "#{contact_path}/conversations"], [:post, "#{contact_path}/conversations"],
          [:get, conversation_path], [:post, "#{conversation_path}/toggle_status"],
          [:post, "#{conversation_path}/toggle_typing"], [:post, "#{conversation_path}/update_last_seen"],
          [:get, "#{conversation_path}/messages"], [:post, "#{conversation_path}/messages"],
          [:patch, "#{conversation_path}/messages/#{message.id}"]
        ]

        requests.each do |verb, path|
          public_send(verb, path, params: { name: 'Intruder', content: 'intruder', typing_status: 'on' })
          expect(response).to have_http_status(:unauthorized), "#{verb.upcase} #{path} returned #{response.status}"
        end
        expect(contact.reload.name).not_to eq('Intruder')
        expect(conversation.reload).to be_open
        expect(conversation.messages.where(content: 'intruder')).to be_empty
        expect(contact_inbox.conversations.count).to eq(1)
      end
    end

    context 'with the signature of another source_id' do
      let(:attacker_contact) { create(:contact, account: account) }
      let!(:attacker_contact_inbox) { create(:contact_inbox, contact: attacker_contact, inbox: api_channel.inbox, source_id: '+525550000002') }
      let(:attacker_headers) { signed_headers(attacker_contact_inbox.source_id) }

      it 'rejects reads and writes on the other thread' do
        get "#{contact_path}/conversations", headers: attacker_headers

        expect(response).to have_http_status(:unauthorized)

        post "#{contact_path}/conversations/#{conversation.display_id}/messages", params: { content: 'spoofed' }, headers: attacker_headers

        expect(response).to have_http_status(:unauthorized)
        expect(conversation.messages.where(content: 'spoofed')).to be_empty
      end

      it 'does not let a query or body param stand in for the signed source_id' do
        get contact_path, params: { contact_id: attacker_contact_inbox.source_id }, headers: attacker_headers

        expect(response).to have_http_status(:unauthorized)

        post "#{inbox_path}/contacts",
             params: { id: attacker_contact_inbox.source_id, source_id: contact_inbox.source_id },
             headers: attacker_headers

        expect(response).to have_http_status(:unauthorized)
        expect(response.parsed_body).not_to have_key('pubsub_token')

        # own path, probing another source_id through the contact_id read by set_contact_inbox
        get contact_path_for(attacker_contact_inbox.source_id), params: { contact_id: contact_inbox.source_id }, headers: attacker_headers

        expect(response).to have_http_status(:unauthorized)
      end

      it 'rejects an identifier_hash equal to its own source signature' do
        own_source_id = attacker_contact_inbox.source_id
        forged = { identifier: own_source_id, identifier_hash: attacker_headers['X-Hablia-Source-Hmac'] }

        get contact_path_for(own_source_id), params: forged, headers: attacker_headers

        expect(response).to have_http_status(:unauthorized)
        expect(attacker_contact_inbox.reload.hmac_verified).to be(false)

        patch contact_path_for(own_source_id), params: forged.merge(phone_number: contact.phone_number), headers: attacker_headers

        expect(response).to have_http_status(:unauthorized)
        expect(Contact.exists?(attacker_contact.id)).to be(true)
        expect(attacker_contact_inbox.reload).to have_attributes(contact_id: attacker_contact.id, hmac_verified: false)
      end

      it 'rejects an identifier_hash signed for any other source_id' do
        other_source_id = '+525550000009'
        forged = { identifier: other_source_id, identifier_hash: signed_headers(other_source_id)['X-Hablia-Source-Hmac'] }

        get contact_path_for(attacker_contact_inbox.source_id), params: forged, headers: attacker_headers

        expect(response).to have_http_status(:unauthorized)
        expect(attacker_contact_inbox.reload.hmac_verified).to be(false)

        patch contact_path_for(attacker_contact_inbox.source_id), params: forged.merge(phone_number: contact.phone_number), headers: attacker_headers

        expect(response).to have_http_status(:unauthorized)
        expect(attacker_contact_inbox.reload).to have_attributes(contact_id: attacker_contact.id, hmac_verified: false)

        post "#{inbox_path}/contacts", params: forged.merge(source_id: attacker_contact_inbox.source_id), headers: attacker_headers

        expect(response).to have_http_status(:unauthorized)
      end

      it 'does not let its own signature take over another contact through contacts#update or #create' do
        patch contact_path_for(attacker_contact_inbox.source_id), params: { phone_number: contact.phone_number }, headers: attacker_headers

        expect(response).not_to have_http_status(:success)
        expect(Contact.exists?(attacker_contact.id)).to be(true)
        expect(attacker_contact_inbox.reload.contact_id).to eq(attacker_contact.id)

        post "#{inbox_path}/contacts", params: { source_id: '+525550000003', phone_number: contact.phone_number },
                                       headers: signed_headers('+525550000003')

        expect(response).not_to have_http_status(:success)
        expect(ContactInbox.exists?(source_id: '+525550000003')).to be(false)
      end
    end

    context 'when creating a contact' do
      it 'rejects a missing source_id instead of generating one' do
        expect do
          post "#{inbox_path}/contacts", headers: signed_headers('')
        end.not_to change(ContactInbox, :count)

        expect(response).to have_http_status(:unauthorized)
      end

      it 'does not hand out an existing contact_inbox without a valid signature' do
        post "#{inbox_path}/contacts", params: { source_id: contact_inbox.source_id }, headers: { 'X-Hablia-Source-Hmac' => 'invalid' }

        expect(response).to have_http_status(:unauthorized)
        expect(response.parsed_body).not_to have_key('pubsub_token')
      end
    end

    context 'when the conversation belongs to another inbox of the same contact' do
      it 'does not reach it by display_id' do
        messages_path = "#{contact_path}/conversations/#{whatsapp_conversation.display_id}/messages"

        get messages_path, headers: owner_headers

        expect(response).to have_http_status(:not_found)

        post messages_path, params: { content: 'cross inbox' }, headers: owner_headers

        expect(response).to have_http_status(:not_found)
        expect(whatsapp_conversation.messages.where(content: 'cross inbox')).to be_empty
      end
    end
  end

  describe 'without hmac_mandatory' do
    let(:api_channel) { create(:channel_api, account: account) }

    it 'keeps serving requests without the signature header' do
      get "#{contact_path}/conversations"

      expect(response).to have_http_status(:success)

      get contact_path

      expect(response).to have_http_status(:success)

      post "#{inbox_path}/contacts"

      expect(response).to have_http_status(:success)
      expect(response.parsed_body['source_id']).to be_present
    end

    it 'keeps marking hmac_verified through identifier_hash' do
      identifier = 'owner-identifier'
      identifier_hash = OpenSSL::HMAC.hexdigest('sha256', api_channel.hmac_token, identifier)

      get contact_path, params: { identifier: identifier, identifier_hash: identifier_hash }

      expect(response).to have_http_status(:success)
      expect(contact_inbox.reload.hmac_verified).to be(true)
    end

    it 'keeps the cross-inbox reach of an hmac_verified contact_inbox' do
      contact_inbox.update!(hmac_verified: true)

      get "#{contact_path}/conversations/#{whatsapp_conversation.display_id}/messages"

      expect(response).to have_http_status(:success)
    end
  end
end
