/** Component catalog page (/_design), dev build only. Everything is composed from ui/, with no custom styles beyond layout. */
import { Plus, Search } from "lucide-react";
import { useState } from "react";
import { strings } from "../lib/strings.vi.ts";
import { AppShell } from "../shell/app-shell.tsx";
import {
  Badge,
  Button,
  Card,
  CheckCard,
  CheckRow,
  Chip,
  Field,
  FieldHelp,
  IconButton,
  MultiSelect,
  Seg,
  Select,
  Skeleton,
  State,
  Textarea,
  Tooltip,
  useToast,
} from "../ui/index.ts";
import "./catalog.css";

const t = strings.design;

export function Catalog() {
  const [day, setDay] = useState<string>("today");
  const [topics, setTopics] = useState<Set<string>>(new Set());
  const [seg, setSeg] = useState<string>("today");
  const toast = useToast();
  return (
    <AppShell crumb={t.title}>
      <main className="ds">
        <h1>{t.title}</h1>

        <section>
          <h2>{t.buttons}</h2>
          <div className="ds-row">
            <Button>{t.primary}</Button>
            <Button variant="secondary" icon={<Plus aria-hidden />}>
              {t.secondary}
            </Button>
            <Button variant="ghost">{t.ghost}</Button>
            <Button disabled>{t.disabled}</Button>
            <IconButton label={t.iconButton}>
              <Search aria-hidden />
            </IconButton>
            <IconButton label={t.iconButton} pressed>
              <Search aria-hidden />
            </IconButton>
          </div>
        </section>

        <section>
          <h2>{t.form}</h2>
          <div className="ds-grid">
            <Card className="ds-pad">
              <h3>{t.checkbox}</h3>
              <CheckRow label={t.checkboxChecked} defaultChecked count={12} />
              <CheckRow label={t.checkboxEmpty} count={3} />
              <div className="ds-row">
                <CheckCard label={t.checkCard} defaultChecked />
                <CheckCard label={t.checkCard} dashed />
              </div>
            </Card>
            <Card className="ds-pad">
              <h3>{t.field}</h3>
              <Field icon={<Search aria-hidden />} placeholder={t.fieldPlaceholder} />
              <FieldHelp aside="0/200">{t.fieldHelp}</FieldHelp>
              <h3>{t.textarea}</h3>
              <Textarea placeholder={t.textareaPlaceholder} />
            </Card>
          </div>
        </section>

        <section>
          <h2>{t.filters}</h2>
          <div className="ds-row">
            <Select value={day} options={t.days} onChange={setDay} label={t.selectDay} />
            <Chip pressed={topics.size === 0} onClick={() => setTopics(new Set())}>
              {t.topicAll}
            </Chip>
            <MultiSelect
              values={topics}
              options={t.topics}
              onChange={setTopics}
              triggerLabel={t.more}
              searchPlaceholder={t.searchTopic}
              emptyLabel={t.noTopic}
            />
          </div>
          <h3>{t.chips}</h3>
          <Seg value={seg} options={t.days} onChange={setSeg} label={t.chips} />
        </section>

        <section>
          <h2>{t.badges}</h2>
          <div className="ds-row">
            {(Object.keys(t.badge) as (keyof typeof t.badge)[]).map((k) => (
              <Badge key={k} status={k}>
                {t.badge[k]}
              </Badge>
            ))}
          </div>
        </section>

        <section>
          <h2>{t.states}</h2>
          <div className="ds-grid">
            <Card className="ds-pad">
              <Skeleton width="60%" height="16px" style={{ marginBottom: 12 }} />
              <Skeleton width="92%" style={{ marginBottom: 8 }} />
              <Skeleton width="75%" />
            </Card>
            <Card>
              <State>{t.ended}</State>
            </Card>
          </div>
        </section>

        <section>
          <h2>
            {t.toast} · {t.tooltip}
          </h2>
          <div className="ds-row">
            <Button variant="secondary" onClick={() => toast(t.toastText)}>
              {t.showToast}
            </Button>
            <Tooltip text={t.tooltipText}>
              <Button variant="ghost">{t.tooltip}</Button>
            </Tooltip>
          </div>
        </section>
      </main>
    </AppShell>
  );
}
