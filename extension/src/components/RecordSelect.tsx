import type { QueryRecord } from "../api/types";
import { countryLabel, queryFilterSummary } from "../ui/display";

type RecordSelectProps = {
  queries: QueryRecord[];
  value: number | "";
  onChange: (id: number | "") => void;
  disabled?: boolean;
  onEdit?: (record: QueryRecord) => void;
};

export function RecordSelect({ queries, value, onChange, disabled = false, onEdit }: RecordSelectProps) {
  const ordered = [...queries].sort((a, b) => a.position - b.position || a.id - b.id);
  const countries = [...new Set(ordered.map((query) => query.country_code))]
    .sort((a, b) => countryLabel(a).localeCompare(countryLabel(b)));

  return (
    <div className="record-select">
      <label className="field">
        <span>Starting record</span>
        <select
          aria-label="Starting record"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value ? Number(event.target.value) : "")}
        >
          <option value="">Choose a saved query</option>
          {countries.map((country) => (
            <optgroup key={country} label={countryLabel(country)}>
              {ordered.filter((query) => query.country_code === country).map((query) => (
                <option key={query.id} value={query.id} disabled={!Boolean(query.enabled)}>
                  {countryLabel(query.country_code)} – {query.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      {value && onEdit && (
        <small className="record-filter-summary">
          {(() => {
            const record = queries.find((query) => query.id === value);
            return record ? <>{queryFilterSummary(record)} · <button type="button" className="inline-link" onClick={() => onEdit(record)}>Edit filters</button></> : null;
          })()}
        </small>
      )}
    </div>
  );
}
