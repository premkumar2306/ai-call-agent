import { useFeatures } from '../features';
import { Card, NotAvailable } from './ui';

// Owner Settings → Phone number: WhatsApp is connected by the Avery team.
export default function WhatsAppNote({ base, auth }: { base: string; auth: Record<string, string> }) {
  const f = useFeatures(base, auth);
  if (!f) return null;
  return (
    <Card title="WhatsApp" description="Your assistant can also answer customers on WhatsApp, with the same services, hours and bookings.">
      {f.whatsapp
        ? <p className="muted small">To use your WhatsApp Business number, ask the Avery team to connect it. Chats then appear in Calls &amp; messages.</p>
        : <NotAvailable feature="WhatsApp" />}
    </Card>
  );
}
