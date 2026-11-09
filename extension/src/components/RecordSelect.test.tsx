// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RecordSelect } from "./RecordSelect";

describe("RecordSelect", () => {
  it("groups records by full country name and reports selection", () => {
    const onChange = vi.fn();
    render(<RecordSelect
      queries={[
        { id: 8, country_code: "GB", label: "London", query_text: "London", position: 2, enabled: 1, notes: "", created_at: "", updated_at: "" },
        { id: 4, country_code: "US", label: "New York", query_text: "New York", position: 1, enabled: 1, notes: "", created_at: "", updated_at: "" }
      ]}
      value=""
      onChange={onChange}
    />);

    const select = screen.getByRole("combobox", { name: "Starting record" });
    expect(screen.getByRole("group", { name: "United States" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "United Kingdom" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "United States – New York" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "United Kingdom – London" })).toBeTruthy();
    fireEvent.change(select, { target: { value: "8" } });
    expect(onChange).toHaveBeenCalledWith(8);
  });

  it("shows a summary of the saved filters and exposes an edit action", () => {
    const query = {
      id: 8,
      country_code: "GB",
      label: "London",
      query_text: "London",
      position: 2,
      enabled: 1,
      notes: "",
      created_at: "",
      updated_at: "",
      date_posted: "week",
      sort_by: "recent",
      content_type: "all"
    };
    const onEdit = vi.fn();
    render(<RecordSelect queries={[query]} value={8} onChange={vi.fn()} onEdit={onEdit} />);

    expect(screen.getByText(/Past week · Most recent · All content/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit filters" }));
    expect(onEdit).toHaveBeenCalledWith(query);
  });
});
