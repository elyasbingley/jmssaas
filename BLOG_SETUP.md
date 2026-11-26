# JMS → website blog posts (job write-ups)

## How it works
1. On **Tuesday, Thursday and Saturday mornings**, `blog-draft` picks a finished job that has photos marked **OK for marketing** (the same toggle Google posts use) and hasn't had a post yet. Claude writes a case study about it (what the problem was, what was found, what was done, tips) from the job's title, description, notes, and invoice or quote lines.
2. The draft waits in **More → Blog Posts** (desktop and phone), and admins get a "New blog post ready to review" notification. Only one scheduled draft waits at a time.
3. An admin edits the title, the Google snippet and the post, then taps **Approve and publish** (or **Skip**).
4. `blog-publish` commits the post and its photos to the website's GitHub repository in one commit. Vercel sees the commit and publishes the site, so the post is live about a minute later at `https://www.bingleytrades.com.au/blog/<slug>`, listed on `/blog` and in the sitemap.

**Write one now** on the desktop Drafts tab writes a draft straight away, without waiting for the schedule.

## Files
**JMS**
- `supabase/migrations/20261202000100_blog_posts.sql`: the `blog_settings` and `blog_posts` tables, admin-only.
- `supabase/functions/_shared/blog.ts`: the GitHub commit, picking a free slug, and the JPEG size.
- `supabase/functions/blog-draft/index.ts`: picks the job and writes the draft (cron, or **Write one now**).
- `supabase/functions/blog-publish/index.ts`: approves the draft and commits it to the website.
- `apps/desktop/src/pages/BlogPosts.tsx`: Drafts (edit, preview, approve, skip), History, Settings.
- `apps/mobile/app/marketing/blog-posts.tsx`: review drafts on the phone.

**Website (`bingley-growth-plan`, branch `claude/jms-blog-posts`)**
- `client/src/content/job-posts/<slug>.json`: one file per post, written by JMS.
- `client/src/content/job-posts/cards/<slug>.json`: the post's card on `/blog`.
- `client/public/images/blog/jobs/<slug>/1.jpg …`: its photos.
- `client/src/pages/JobPost.tsx`, `client/src/components/JobPostBody.tsx`, `client/src/lib/jobPostRoutes.ts`, `client/src/data/jobPosts.ts`: the page that shows them.
- `site-routes.js`: adds each post to the pre-rendered pages and the sitemap.

## The post format
Plain text with a few marks, so the website can show it safely:
- `## Heading` or `### Smaller heading`
- `- list item` (one per line)
- `**bold**`
- `[link text](/our-services/...)`: links must start with `/` or `https://`
- `[[photo:2]]` on its own line places photo 2. Photo 1 is shown at the top unless the post places it.

Leave a blank line between paragraphs. **Preview** on the desktop shows roughly how it will look.

## Setup

### 1. Put the website changes live (once)
The website needs the new job-post page before JMS can publish to it. Merge the website branch `claude/jms-blog-posts` into `main`. Vercel then deploys it. Nothing changes on the site until the first post is published.

> From now on, JMS adds commits to the website's `main`. **Pull before you change the website yourself** (or in your website tool), or your push will be rejected.

### 2. Run the migration
```bash
cd ~/jmssaas            # wherever your copy is
git pull
npx supabase db push --remote
```

### 3. Make a GitHub token for the website
1. GitHub → your picture → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Name: `JMS blog`. Expiration: up to a year (put a reminder in your calendar to renew it).
3. **Repository access → Only select repositories → `bingley-growth-plan`**.
4. **Permissions → Repository permissions → Contents → Read and write**. Leave everything else as it is.
5. Generate it and copy it. Don't paste it anywhere else. Put it straight into the command below in Terminal.

### 4. Secrets and deploy
`ANTHROPIC_API_KEY`, `ANTHROPIC_WORKSPACE_ID` (if you set one) and `CRON_SECRET` are already set for Google posts, and the blog uses the same ones.
```bash
npx supabase secrets set WEBSITE_GITHUB_TOKEN=PASTE_THE_TOKEN_HERE
npx supabase functions deploy blog-draft --no-verify-jwt
npx supabase functions deploy blog-publish
```

### 5. Settings
In JMS on the desktop, open **More → Blog Posts → Settings**:
- **GitHub repository:** `elyasbingley/bingley-growth-plan`
- **Branch:** `main`
- **Website address:** `https://www.bingleytrades.com.au`
- **Business name** and **What the business is**.
- **Extra rules for the writer** (optional): e.g. "Link to /our-services/roof-repairs when it fits."
- Tick **Write blog drafts on a schedule**, then **Save settings**.

### 6. Schedule (pg_cron)
In the Supabase **SQL Editor**, run this once. It uses the `gbp_cron_secret` already saved in Vault for Google posts:
```sql
select cron.schedule(
  'blog-draft-ttsa',
  '0 20 * * 1,3,5',
  $$
  select net.http_post(
    url     := 'https://qnlxmpxjmmhcnzzpcabd.supabase.co/functions/v1/blog-draft',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'gbp_cron_secret')
    ),
    body    := '{}'::jsonb,
    -- A whole post takes longer to write than a Google caption.
    timeout_milliseconds := 150000
  );
  $$
);
```
`0 20 * * 1,3,5` is 20:00 UTC on Monday, Wednesday and Friday. In Sydney that is 7am on Tuesday, Thursday and Saturday during daylight saving, and 6am in winter.

### 7. Test it end to end
1. Make sure a finished job has 1–4 photos marked **OK for marketing**.
2. **More → Blog Posts → Write one now**. It takes up to a minute.
3. Read the draft, fix anything, and press **Preview** to check it.
4. **Approve and publish**. In GitHub you'll see a commit called `Blog: <title>`. About a minute later the post is on the website, and **History → View on the website** opens it.

## Notes
- **One post per job.** Skipping a draft keeps that job from being suggested again.
- **Addresses never clash** with existing pages. If `/blog/<slug>` is already taken (a hand-written post or an earlier job post), the new post gets `-2`, `-3` and so on.
- **If publishing fails** (for example, an expired token), the post shows under **History** as *failed* with the reason, and has a **Try again** button.
- **To take a post down**, delete its two JSON files and its photo folder in the website repo (see Files above), then commit. Vercel republishes without it.
- **Photos on the website are public.** Check each one for faces, house numbers and number plates before marking it OK for marketing. The copies have no GPS or other camera data.
- **Suburb only.** The writer is told never to use street addresses or client names. The draft's warnings flag anything it wasn't sure about.
