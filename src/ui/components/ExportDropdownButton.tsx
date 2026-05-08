import { useCallback, useRef, useState } from "react";
import { Download } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@ui/components/ui/tooltip";

function waitForNextPaint() {
    return new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => resolve());
        });
    });
}

export default function ExportDropdownButton({
    onExportJSON,
    onExportMarkdown,
    className,
    iconClassName = "h-[13px] w-[13px]",
    tooltipSide = "bottom",
    dropdownAlign = "end",
}: {
    onExportJSON: () => Promise<void>;
    onExportMarkdown: () => Promise<void>;
    className?: string;
    iconClassName?: string;
    tooltipSide?: "top" | "right" | "bottom" | "left";
    dropdownAlign?: "start" | "center" | "end";
}) {
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const [tooltipOpen, setTooltipOpen] = useState(false);
    const [suppressTooltip, setSuppressTooltip] = useState(false);
    const buttonRef = useRef<HTMLButtonElement>(null);

    const clearFocus = useCallback(() => {
        buttonRef.current?.blur();
    }, []);

    const dismissChrome = useCallback(() => {
        setDropdownOpen(false);
        setTooltipOpen(false);
        setSuppressTooltip(true);
        clearFocus();
    }, [clearFocus]);

    const handleExportSelection = useCallback(
        (runExport: () => Promise<void>) => {
            dismissChrome();
            void (async () => {
                await waitForNextPaint();
                try {
                    await runExport();
                } finally {
                    clearFocus();
                }
            })();
        },
        [clearFocus, dismissChrome],
    );

    return (
        <DropdownMenu
            open={dropdownOpen}
            onOpenChange={(open) => {
                setDropdownOpen(open);
                if (!open) {
                    setTooltipOpen(false);
                    clearFocus();
                }
            }}
        >
            <Tooltip
                open={dropdownOpen || suppressTooltip ? false : tooltipOpen}
                onOpenChange={(open) => {
                    if (dropdownOpen || suppressTooltip) {
                        setTooltipOpen(false);
                        return;
                    }
                    setTooltipOpen(open);
                }}
            >
                <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                        <button
                            ref={buttonRef}
                            type="button"
                            aria-label="Export chat"
                            onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                            }}
                            onPointerDown={() => {
                                setTooltipOpen(false);
                            }}
                            onPointerLeave={() => {
                                setTooltipOpen(false);
                                setSuppressTooltip(false);
                            }}
                            className={className}
                        >
                            <Download className={iconClassName} />
                        </button>
                    </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side={tooltipSide}>Export chat</TooltipContent>
            </Tooltip>
            <DropdownMenuContent
                align={dropdownAlign}
                onClick={(e) => e.stopPropagation()}
                onCloseAutoFocus={(e) => {
                    e.preventDefault();
                    clearFocus();
                }}
            >
                <DropdownMenuItem
                    onSelect={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        handleExportSelection(onExportJSON);
                    }}
                >
                    Export as JSON
                </DropdownMenuItem>
                <DropdownMenuItem
                    onSelect={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        handleExportSelection(onExportMarkdown);
                    }}
                >
                    Export as Markdown
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
