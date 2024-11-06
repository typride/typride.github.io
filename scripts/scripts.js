document.addEventListener("DOMContentLoaded", function() {
    console.log("Page loaded");

    // Select the About, Experience, and Projects sections
    const aboutSection = document.getElementById("about");
    const experienceSection = document.getElementById("experience");
    const projectsSection = document.getElementById("projects");
    const experienceItems = document.querySelectorAll(".experience-item.hidden");

    // Fade in the About Me section on page load
    aboutSection.classList.add("fade-in");
    console.log("About section fading in");

    // Trigger Experience fade-in after About Me transition ends
    aboutSection.addEventListener("transitionend", () => {
        console.log("About section transition ended");

        experienceSection.classList.add("fade-in");
        console.log("Experience section fading in");

        // Sequentially fade in each experience item within the Experience section
        experienceItems.forEach((item, index) => {
            setTimeout(() => {
                item.classList.remove("hidden");
                item.classList.add("fade-in");
                console.log(`Fading in experience item ${index + 1}`);

                // After the last experience item, fade in the Projects section
                if (index === experienceItems.length - 1) {
                    setTimeout(() => {
                        projectsSection.classList.remove("hidden");
                        projectsSection.classList.add("fade-in");
                        console.log("Projects section fading in");
                    }, 600); // Delay before the projects section starts to fade in
                }
            }, index * 300); // Delay between each experience item
        });
    });
});