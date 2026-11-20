# Email deliverability: deskzen.in (Microsoft 365)

Goal: DKIM, SPF and DMARC all pass for mail sent from `premkumar@deskzen.in`. DKIM is the missing piece. DMARC stays `p=quarantine`.

## 1. Get the DKIM CNAMEs (Microsoft 365 admin login needed)
1. Open https://security.microsoft.com (Defender portal).
2. **Email & collaboration → Policies & rules → Threat policies → Email authentication settings → DKIM**.
3. Click **deskzen.in**, then **Create DKIM keys**.
4. A box shows two CNAMEs. Copy both exactly. Do not guess the tenant name:
   - `selector1._domainkey` → `selector1-deskzen-in._domainkey.<tenant>.onmicrosoft.com`
   - `selector2._domainkey` → `selector2-deskzen-in._domainkey.<tenant>.onmicrosoft.com`

PowerShell alternative (Exchange Online module; *verify against Microsoft docs, not checked from the sandbox*):
```
Connect-ExchangeOnline
New-DkimSigningConfig -DomainName deskzen.in -Enabled $false   # only if none exists
Get-DkimSigningConfig -Identity deskzen.in | Format-List Selector1CNAME, Selector2CNAME, Enabled
# later, after DNS has propagated:
Set-DkimSigningConfig -Identity deskzen.in -Enabled $true
```

## 2. Add the CNAMEs in DNS (Cloudflare or wherever deskzen.in is hosted)
1. Add CNAME, name `selector1._domainkey`, target = the value copied above.
2. Add CNAME, name `selector2._domainkey`, target = the value copied above.
3. For both: **Proxy status OFF (DNS only, grey cloud)**, TTL Auto.
4. Wait for propagation (usually minutes, up to an hour). Check: `node campaigns/india-dental-leads/scripts/check-email-auth.mjs --domain deskzen.in` shows ✓ for both selectors.
5. Back in Defender → DKIM → deskzen.in, switch **Sign messages for this domain with DKIM signatures** to **Enabled** (or `Set-DkimSigningConfig ... -Enabled $true`). If it errors that the CNAME isn't found, wait and retry.

## 3. MX cleanup
Keep only `deskzen-in.mail.protection.outlook.com`, priority 0.
1. Before deleting the old `domain-com` MX, confirm it is unused: Microsoft 365 admin center → **Settings → Domains → deskzen.in** shows no MX errors, and you use no other mail provider for deskzen.in.
2. If both hold, delete that one MX record.
3. Do not touch SPF, DMARC or website records.

## 4. Verify
1. `node campaigns/india-dental-leads/scripts/check-email-auth.mjs --domain deskzen.in` → no ✗ on DKIM or MX (exit code 0).
2. Send a test email from `premkumar@deskzen.in` to your own Gmail. Open it → ⋮ → **Show original**. It must show `DKIM: PASS`, `SPF: PASS`, `DMARC: PASS`.

## 5. Optional later
Add a DMARC `rua=mailto:<your address>` reporting tag to the `_dmarc` TXT record. Keep `p=quarantine`.

## Campaign safety
`cloud-email-campaign.mjs` runs this check before every `send` batch. If DKIM or MX fails, the batch is skipped with a warning, nothing is sent and the delivery ledger is not touched. SPF and DMARC problems only warn.
