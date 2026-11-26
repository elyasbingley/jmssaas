# JMS → Google Business Profile auto-posting (via Zapier)

## How it works

1. You (or a tech) flag a job photo **"OK for marketing"**. The app makes a resized copy with the GPS data stripped and uploads it to the public `marketing` bucket.
2. On Monday, Wednesday and Friday mornings, `gbp-draft` picks an unused flagged photo, rotating through job types, and has Claude write the caption. It saves the result as a **draft** and notifies the admins (bell and push).
3. You open **Marketing → Google Posts** in JMS, then tap **Approve** (with any edits) or **Skip**.
4. Approve calls `gbp-publish`, which POSTs to the Zapier webhook. Zapier creates the post on your profile.

## Files

| File | What it is |
|---|---|
| `supabase/migrations/20261201000100_gbp_posts.sql` | Tables, photo columns on `job_files`, `set_job_file_marketing()`, RLS, `marketing` bucket |
| `supabase/functions/_shared/gbp.ts` | Shared publish-to-Zapier + caption cleanup |
| `supabase/functions/gbp-draft/index.ts` | Scheduled: pick photo → Claude caption → draft → notify admins |
| `supabase/functions/gbp-publish/index.ts` | Called by the app when you approve |
| `apps/mobile/lib/marketing-photo.ts` | Flag/unflag a photo for marketing (makes the stripped copy) |

## In the app

- **Marking a photo OK for marketing:**
  - **Desktop:** on a job, hover a photo and click **📣 OK for marketing?**. It then shows **📣 Marketing**; click again to stop using it.
  - **Phone:** in the job's Diary, hold a photo, then choose **OK for marketing**. Flagged photos have a 📣 badge. This needs a connection.
  - **What gets made:** a copy at most 1600px wide, with no location data, in the public `marketing` bucket.
  - **Unflagging:** removes the copy, unless a post already uses it.
- **Marketing → Google Posts** (desktop: More → Google Posts; phone: More → Google Posts). Admins only.
  - **Drafts:** the photo, the caption (edit it here), the button, and any concerns as warning chips. **Approve and post** (or **Approve anyway** when there are concerns) sends it through `gbp-publish`. **Skip** drops it, and the photo isn't suggested again.
  - **History:** published, failed and skipped posts, with the error for failed ones and **Try again**.
  - **Settings** (desktop only):
    - drafts on or off, and auto-publish;
    - the Zapier webhook (hidden once saved);
    - the business name and description, and extra rules for the writer;
    - the default button and link, and the service pages.
- **Notification:** a new draft notifies admins ("New Google post ready to review"). Tapping it opens Google Posts.

## Fitted to JMS

The first draft of these files was written without the repo. These are the names it now uses:
- **Jobs are `job_cards`.** A job has no suburb column, so the suburb comes from its site, then its agency property, then its client. The "job type" is the job's service category name.
- **Photos are `job_files`**, which holds photos and other files. Only `image/*` files can be flagged. The job link is `job_card_id`.
- **There is no `tenant_members` table.** Users are `profiles`, with role `admin` or `technician`, checked through `current_tenant_id()` and `is_admin()`. Admins manage posting.
- **Who can flag a photo:** anyone who can see the job, so admins and the job's tech.
- **Flags go through `set_job_file_marketing()`**, because `job_files` rows can't be edited directly.
- **PowerSync:** sync rules already send every `job_files` column. The client schema now has `marketing_ok`, `marketing_path` and `used_in_post_id`.

---

## Setup

### 1. Run the migration
```bash
npx supabase db push --remote
```

### 2. Secrets and deploy
`ANTHROPIC_API_KEY` is probably already set, because the Inbox uses it. Check with `npx supabase secrets list`. Make a new `CRON_SECRET`:
```bash
openssl rand -hex 24          # copy the output, you need it in step 4
npx supabase secrets set CRON_SECRET=PASTE_IT_HERE
npx supabase functions deploy gbp-draft --no-verify-jwt
npx supabase functions deploy gbp-publish
```

### 3. Settings
Fill these in at **More → Google Posts → Settings** on the desktop:
- the Zapier webhook URL;
- the business name and description;
- the default button;
- the service page links.

### 4. Schedule (pg_cron)
Store the secret in Vault, then schedule the job. pg_cron runs on **UTC**, so `0 20 * * 0,2,4` is **7am Mon/Wed/Fri in Sydney during daylight saving**. In winter (AEST) it fires at 6am.
```sql
select vault.create_secret('PASTE_CRON_SECRET', 'gbp_cron_secret');

select cron.schedule(
  'gbp-draft-mwf',
  '0 20 * * 0,2,4',
  $$
  select net.http_post(
    url     := 'https://qnlxmpxjmmhcnzzpcabd.supabase.co/functions/v1/gbp-draft',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'gbp_cron_secret')
    ),
    body    := '{}'::jsonb
  );
  $$
);
```

### 5. Test it end to end
1. Flag 2–3 recent job photos with the **OK for marketing** toggle.
2. Download one of the `marketing/...jpg` files, open it in **Preview → Tools → Show Inspector**, and confirm there's **no GPS tab**. Also check that it isn't rotated sideways.
3. Run a draft by hand:
   ```bash
   curl -X POST https://qnlxmpxjmmhcnzzpcabd.supabase.co/functions/v1/gbp-draft \
     -H "Content-Type: application/json" \
     -H "x-cron-secret: YOUR_CRON_SECRET" \
     -d '{"tenant_id":"YOUR-TENANT-UUID"}'
   ```
4. Open **Marketing → Google Posts**. Read the caption and any concerns.
5. Turn the **Zap ON** and approve the draft. Check that the post appears on your profile.

---

## Notes
- **Auto-publish** only fires when Claude reports no concerns. Leave it off for the first few weeks.
- **One draft at a time.** While a draft is waiting for review, no new one is made, unless auto-publish is on.
- **If Claude declines a photo**, the run fails for that photo and leaves it unused, so the same photo is tried again next run. Unflag it to stop that.
- **A 200 from Zapier only means Zapier received the post.** If Google rejects it, the error shows in Zapier's Zap History. Turn on Zapier's error emails.
- **Moving to the direct Google API later:** reapply for API access once the category change is past 60 days. Then replace the `fetch(zapier_webhook_url)` in `_shared/gbp.ts` with a call to `localPosts.create`. Nothing else needs to change.
- **Model:** `claude-sonnet-5-5`, through the official SDK.
  - **Structured output:** the reply is always valid JSON in the right shape.
  - **Server-side fallback:** if Sonnet 5.5's safety checks decline, the API retries on another model in the same call.
  - **Cost:** roughly one cent per caption.
