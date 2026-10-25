"""Render a static scientific summary from saved, measured detection metrics."""
import argparse
import json
import os
from pathlib import Path


def plot(report_path, output):
    os.environ.setdefault("MPLCONFIGDIR", str(Path(__file__).resolve().parent / ".cache" / "matplotlib"))
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    report=json.loads(Path(report_path).read_text(encoding="utf-8"))
    rows=report["test"]
    if len(rows)!=2 or "improvement" not in report:
        raise ValueError("Need a completed baseline/candidate comparison")
    names=["YOLO11s\nconf 0.25","RF-DETR Small\nconf 0.45"]
    colors=["#476b96","#168472"]
    fig,axes=plt.subplots(1,4,figsize=(14,4.7))
    for ax,key,title in zip(axes[:3],("precision","recall","f1"),("Precision","Recall","F1")):
        values=[100*row["metrics"][key] for row in rows]
        ax.bar(names,values,color=colors,width=.6)
        ax.set_ylim(0,108)
        ax.set_title(title)
        for index,value in enumerate(values):
            ax.text(index,value+2,f"{value:.1f}%",ha="center",fontweight="bold")
        ax.spines[["top","right"]].set_visible(False)
    latency=[row["latency_ms"]["median"]/1000 for row in rows]
    axes[3].bar(names,latency,color=colors,width=.6)
    axes[3].set_ylim(0,max(latency)*1.3)
    axes[3].set_title("CPU median (seconds)")
    for index,value in enumerate(latency):
        axes[3].text(index,value+max(latency)*.04,f"{value:.2f}s",ha="center",fontweight="bold")
    axes[3].spines[["top","right"]].set_visible(False)
    n=rows[0]["metrics"]["images"]
    count=rows[0]["metrics"]["tp"]+rows[0]["metrics"]["fn"]
    interval=report["improvement"]["f1_difference_interval"]
    fig.suptitle(f"Fresh COCO confirmation: {n} images, {count} labeled vehicles",fontsize=16,fontweight="bold")
    fig.text(.5,.04,f"Vehicle detection at IoU 0.5. F1 difference {report['improvement']['f1_pp']:+.2f} pp; "
             f"95% image-bootstrap interval [{interval['low_pp']:+.2f}, {interval['high_pp']:+.2f}] pp.\n"
             "Exploratory sample; NOT Castro empty-parking accuracy. No training or paid API calls.",
             ha="center",fontsize=10)
    fig.tight_layout(rect=(0,.16,1,.9))
    target=Path(output)
    target.parent.mkdir(parents=True,exist_ok=True)
    fig.savefig(target,dpi=160,facecolor="white")
    plt.close(fig)


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report",default="worker/benchmarks/vehicle-confirmation/report.json")
    parser.add_argument("--output",default="docs/vision-evaluation/confirmation.png")
    args=parser.parse_args()
    plot(args.report,args.output)
