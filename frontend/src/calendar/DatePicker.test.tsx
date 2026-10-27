import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { vi } from "vitest";
import { DatePicker } from "./DatePicker";

vi.mock("@/auth/AuthContext", () => ({
  useAuth: () => ({ session: { organization: { date_input_calendar: "BS", timezone: "Asia/Kathmandu" } }, dateMode: "AD_BS" }),
}));

function Harness({ onChange }: { onChange: (v: string) => void }) {
  const [value, setValue] = useState("");
  return <DatePicker id="d" value={value} onChange={(v) => { setValue(v); onChange(v); }} />;
}

describe("DatePicker", () => {
  it("accepts a typed BS date, stores AD and shows the AD equivalent", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "2083-01-01" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("2026-04-14");
    expect(screen.getByText("AD 2026-04-14")).toBeInTheDocument();
  });

  it("rejects a day that does not exist in the BS month", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "2083-01-32" } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/has 31 days; day 32 is invalid/)).toBeInTheDocument();
  });

  it("switches to AD entry", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByTitle("Enter in AD"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "2026-07-17" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("2026-07-17");
    expect(screen.getByText("BS 2083-04-01")).toBeInTheDocument();
  });
});
